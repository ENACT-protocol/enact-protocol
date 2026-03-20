/**
 * ENACT Protocol Indexer — runs inside the bot process.
 * Backfills all jobs on startup, then uses Toncenter Streaming API v2 SSE
 * for real-time transaction tracking with pending/confirmed/finalized states.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { TonClient } from '@ton/ton';
import { Address } from '@ton/core';

const FACTORY = 'EQAFHodWCzrYJTbrbJp1lMDQLfypTHoJCd0UcerjsdxPECjX';
const JETTON_FACTORY = 'EQCgYmwi8uwrG7I6bI3Cdv0ct-bAB1jZ0DQ7C3dX3MYn6VTj';
const STATE_NAMES = ['OPEN', 'FUNDED', 'SUBMITTED', 'COMPLETED', 'DISPUTED', 'CANCELLED'];
const ZERO_HASH = '0'.repeat(64);
const PINATA_GW = process.env.PINATA_GATEWAY || 'https://green-known-basilisk-878.mypinata.cloud/ipfs';
const API_KEY = process.env.TONCENTER_API_KEY || '';
const SSE_URL = 'https://toncenter.com/api/streaming/v2/sse';

let supabase: SupabaseClient | null = null;
let sseAbort: AbortController | null = null;

function log(msg: string) {
    console.log(`[IDX ${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

function getSupabase(): SupabaseClient | null {
    if (supabase) return supabase;
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) return null;
    supabase = createClient(url, key);
    return supabase;
}

function getClient(): TonClient {
    return new TonClient({ endpoint: 'https://toncenter.com/api/v2/jsonRPC', apiKey: API_KEY });
}

// ─── Content Resolution ───

async function resolveContent(hash: string): Promise<{ text: string | null; ipfsUrl: string | null }> {
    if (!hash || hash === ZERO_HASH) return { text: null, ipfsUrl: null };
    try {
        const clean = hash.replace(/0+$/, '');
        if (clean.length >= 4) {
            const bytes = Buffer.from(clean, 'hex').toString('utf-8').replace(/\0/g, '');
            if (/^[\x20-\x7E\n\r\t]+$/.test(bytes) && bytes.length > 2) return { text: bytes, ipfsUrl: null };
        }
    } catch {}
    if (process.env.PINATA_JWT) {
        try {
            const url = `https://api.pinata.cloud/data/pinList?status=pinned&pageLimit=1&metadata[keyvalues]={"descHash":{"value":"${hash}","op":"eq"}}`;
            const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.PINATA_JWT}` }, signal: AbortSignal.timeout(8000) });
            if (res.ok) {
                const pins = await res.json() as { rows: Array<{ ipfs_pin_hash: string }> };
                if (pins.rows?.length > 0) {
                    const cid = pins.rows[0].ipfs_pin_hash;
                    const ipfsUrl = `${PINATA_GW}/${cid}`;
                    try {
                        const cr = await fetch(ipfsUrl, { signal: AbortSignal.timeout(8000) });
                        if (cr.ok) {
                            const d = await cr.json() as Record<string, any>;
                            return { text: d.description ?? d.result ?? d.reason ?? JSON.stringify(d), ipfsUrl };
                        }
                    } catch {}
                    return { text: null, ipfsUrl };
                }
            }
        } catch {}
    }
    return { text: null, ipfsUrl: null };
}

// ─── Transaction Fetching ───

async function fetchTransactions(address: string): Promise<any[]> {
    try {
        const url = `https://toncenter.com/api/v2/getTransactions?address=${encodeURIComponent(address)}&limit=20&archival=true${API_KEY ? `&api_key=${API_KEY}` : ''}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) return [];
        const data = await res.json() as { ok: boolean; result?: any[] };
        return data.ok ? (data.result ?? []) : [];
    } catch { return []; }
}

// ─── Job Indexing (only for finalized state) ───

async function indexJob(client: TonClient, factory: string, jobId: number, type: 'ton' | 'usdt') {
    const sb = getSupabase();
    if (!sb) return;

    try {
        const addrResult = await client.runMethod(Address.parse(factory), 'get_job_address', [
            { type: 'int', value: BigInt(jobId) },
        ]);
        const jobAddr = addrResult.stack.readAddress().toString();

        // Skip terminal jobs already indexed
        const { data: existing } = await sb.from('jobs').select('state').eq('address', jobAddr).single();
        if (existing && [3, 4, 5].includes(existing.state)) return;

        const result = await client.runMethod(Address.parse(jobAddr), 'get_job_data');
        const jid = result.stack.readNumber();
        const clientAddr = result.stack.readAddress();
        const providerAddr = result.stack.readAddressOpt();
        const evaluatorAddr = result.stack.readAddress();
        const budget = result.stack.readBigNumber();
        const descHash = result.stack.readBigNumber();
        const resultHash = result.stack.readBigNumber();
        const timeout = result.stack.readNumber();
        const createdAt = result.stack.readNumber();
        const evalTimeout = result.stack.readNumber();
        const submittedAt = result.stack.readNumber();
        const resultType = result.stack.readNumber();
        const reason = result.stack.readBigNumber();
        const state = result.stack.readNumber();

        const stateName = STATE_NAMES[state] ?? 'UNKNOWN';
        const uf = { bounceable: false };
        const budgetNum = Number(budget);
        const budgetFormatted = type === 'usdt'
            ? `${(budgetNum / 1e6).toFixed(2)} USDT`
            : `${(budgetNum / 1e9).toFixed(2)} TON`;

        const descHashHex = descHash.toString(16).padStart(64, '0');
        const resultHashHex = resultHash.toString(16).padStart(64, '0');
        const [descContent, resultContent, reasonContent] = await Promise.all([
            resolveContent(descHashHex),
            resolveContent(resultHashHex),
            state >= 3 ? resolveContent(reason.toString(16).padStart(64, '0')) : Promise.resolve({ text: null, ipfsUrl: null }),
        ]);

        const rawTxs = await fetchTransactions(jobAddr);
        const txs = rawTxs.map((tx: any) => ({
            hash: tx.transaction_id?.hash ? Buffer.from(tx.transaction_id.hash, 'base64').toString('hex') : '',
            fee: (Number(tx.fee || 0) / 1e9).toFixed(4),
            utime: tx.utime || 0,
            from: tx.in_msg?.source || null,
        }));

        const effectiveCreatedAt = createdAt || (txs.length > 0 ? txs[txs.length - 1].utime : 0);

        const { error: jobErr } = await sb.from('jobs').upsert({
            job_id: jobId, factory_type: type, address: jobAddr, factory_address: factory,
            state, state_name: stateName,
            client: clientAddr.toString(uf), provider: providerAddr?.toString(uf) ?? null,
            evaluator: evaluatorAddr.toString(uf), budget: budgetNum, budget_formatted: budgetFormatted,
            desc_hash: descHashHex, result_hash: resultHashHex,
            timeout, created_at: effectiveCreatedAt, eval_timeout: evalTimeout,
            submitted_at: submittedAt, result_type: resultType,
            description_text: descContent.text, description_ipfs_url: descContent.ipfsUrl,
            result_text: resultContent.text, result_ipfs_url: resultContent.ipfsUrl,
            reason_text: reasonContent.text, updated_at: new Date().toISOString(),
        }, { onConflict: 'address' });
        if (jobErr) log(`  DB ERR jobs: ${jobErr.message}`);

        for (const tx of txs) {
            if (!tx.hash) continue;
            await sb.from('transactions').upsert({
                job_address: jobAddr, tx_hash: tx.hash, fee: tx.fee,
                utime: tx.utime, from_address: tx.from,
            }, { onConflict: 'tx_hash' });
        }

        // Activity events
        const chronTxs = [...txs].reverse();
        const isUsdt = type === 'usdt';
        const clientStr = clientAddr.toString(uf);
        const providerStr = providerAddr?.toString(uf) ?? null;
        const evaluatorStr = evaluatorAddr.toString(uf);
        const takeBase = isUsdt ? 3 : 2;
        const subIdx = providerStr ? takeBase + 1 : takeBase;

        const addAct = async (event: string, status: string, time: number, amount: string | null, from: string | null, txHash: string | null) => {
            const { data: ex } = await sb.from('activity_events').select('id').eq('job_address', jobAddr).eq('event', event).limit(1);
            if (ex && ex.length > 0) return;
            await sb.from('activity_events').insert({
                job_id: jobId, factory_type: type, job_address: jobAddr,
                event, status, time, amount, from_address: from, tx_hash: txHash,
            });
        };

        if (effectiveCreatedAt && chronTxs[0]) await addAct('Created', 'OPEN', chronTxs[0].utime || effectiveCreatedAt, budgetFormatted, clientStr, chronTxs[0].hash);
        const fundIdx = isUsdt ? 2 : 1;
        if (state >= 1 && chronTxs[fundIdx]) await addAct('Funded', 'FUNDED', chronTxs[fundIdx].utime, budgetFormatted, clientStr, chronTxs[fundIdx].hash);
        if (providerStr && chronTxs[takeBase]) await addAct('Taken', 'FUNDED', chronTxs[takeBase].utime, null, providerStr, chronTxs[takeBase].hash);
        if (submittedAt && chronTxs[subIdx]) await addAct('Submitted', 'SUBMITTED', chronTxs[subIdx].utime, budgetFormatted, providerStr, chronTxs[subIdx].hash);
        const lastTx = chronTxs[chronTxs.length - 1];
        if (stateName === 'COMPLETED' && lastTx) await addAct('Approved', 'COMPLETED', lastTx.utime, `${budgetFormatted} → Provider`, evaluatorStr, lastTx.hash);
        if (stateName === 'CANCELLED' && lastTx) await addAct('Cancelled', 'CANCELLED', lastTx.utime, `${budgetFormatted} → Client`, clientStr, lastTx.hash);
        if (stateName === 'DISPUTED' && lastTx) await addAct('Rejected', 'DISPUTED', lastTx.utime, budgetFormatted, evaluatorStr, lastTx.hash);

        log(`${type.toUpperCase()} #${jobId} ${stateName}`);
    } catch (err: any) {
        log(`Err ${type} #${jobId}: ${err.message}`);
    }
}

// ─── Backfill ───

async function backfill() {
    const sb = getSupabase();
    if (!sb) return;
    log('Backfilling...');
    const client = getClient();

    for (const { factory, type } of [
        { factory: FACTORY, type: 'ton' as const },
        { factory: JETTON_FACTORY, type: 'usdt' as const },
    ]) {
        try {
            const countResult = await client.runMethod(Address.parse(factory), 'get_next_job_id');
            const count = countResult.stack.readNumber();
            log(`${type.toUpperCase()}: ${count} jobs`);
            for (let i = 0; i < count; i++) {
                await new Promise(r => setTimeout(r, 500));
                await indexJob(client, factory, i, type);
            }
            await sb.from('indexer_state').upsert({
                factory_address: factory, last_job_count: count,
                updated_at: new Date().toISOString(),
            }, { onConflict: 'factory_address' });
        } catch (err: any) {
            log(`Backfill err ${type}: ${err.message}`);
        }
    }
    log('Backfill done.');
}

// ─── SSE Streaming ───

let trackedAddresses: string[] = [FACTORY, JETTON_FACTORY];

async function refreshTrackedAddresses() {
    const sb = getSupabase();
    if (!sb) return;
    const { data } = await sb.from('jobs').select('address').in('state', [0, 1, 2]);
    const jobAddrs = (data ?? []).map((j: any) => j.address);
    trackedAddresses = [FACTORY, JETTON_FACTORY, ...jobAddrs];
}

function reconnectSSE() {
    if (sseAbort) { sseAbort.abort(); sseAbort = null; }
}

async function connectSSE() {
    const client = getClient();
    const sb = getSupabase();
    if (!sb) return;

    while (true) {
        try {
            await refreshTrackedAddresses();
            log(`SSE connecting with ${trackedAddresses.length} addresses...`);

            sseAbort = new AbortController();
            const res = await fetch(SSE_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'text/event-stream',
                    ...(API_KEY ? { 'X-API-Key': API_KEY } : {}),
                },
                body: JSON.stringify({
                    addresses: trackedAddresses,
                    types: ['transactions'],
                    min_finality: 'pending',
                }),
                signal: sseAbort.signal,
            });

            if (!res.ok || !res.body) {
                const wait = res.status === 429 ? 60000 : 5000;
                log(`SSE failed: ${res.status} — retrying in ${wait / 1000}s`);
                await new Promise(r => setTimeout(r, wait));
                continue;
            }

            log('SSE connected!');
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';

                for (const line of lines) {
                    if (line.startsWith(':') || !line.startsWith('data: ')) continue;
                    try {
                        const event = JSON.parse(line.slice(6));
                        if (event.type !== 'transactions' || !event.transactions) continue;
                        const finality = event.finality || 'finalized';

                        for (const tx of event.transactions) {
                            let account = tx.account;
                            try { account = Address.parse(tx.account).toString(); } catch {}

                            // Handle factory txs: any finality triggers quick-poll for new jobs
                            if (account === FACTORY || account === JETTON_FACTORY) {
                                if (finality === 'pending') {
                                    log(`SSE: ${account === FACTORY ? 'TON' : 'USDT'} factory tx [pending] — quick-polling...`);
                                    // Quick poll: check every 3s for 30s until new job appears
                                    const type = account === FACTORY ? 'ton' : 'usdt';
                                    (async () => {
                                        for (let attempt = 0; attempt < 10; attempt++) {
                                            await new Promise(r => setTimeout(r, 3000));
                                            try {
                                                const countResult = await client.runMethod(Address.parse(account), 'get_next_job_id');
                                                const count = countResult.stack.readNumber();
                                                const state = await sb.from('indexer_state').select('last_job_count').eq('factory_address', account).single();
                                                const lastCount = state?.data?.last_job_count ?? 0;
                                                if (count > lastCount) {
                                                    log(`SSE quick-poll: ${type.toUpperCase()} ${count - lastCount} new job(s)!`);
                                                    for (let i = lastCount; i < count; i++) {
                                                        await indexJob(client, account, i, type);
                                                    }
                                                    await sb.from('indexer_state').upsert({
                                                        factory_address: account, last_job_count: count,
                                                        updated_at: new Date().toISOString(),
                                                    }, { onConflict: 'factory_address' });
                                                    reconnectSSE();
                                                    return;
                                                }
                                            } catch {}
                                        }
                                    })().catch(() => {});
                                }
                            } else {
                                // Job contract tx — any finality
                                if (finality === 'pending') {
                                    // On pending, start quick-poll for state change
                                    const matchAddr = account;
                                    const { data: job } = await sb.from('jobs').select('job_id, factory_type, factory_address, state').eq('address', matchAddr).single();
                                    if (job) {
                                        log(`SSE: ${job.factory_type.toUpperCase()} #${job.job_id} tx [pending] — quick-polling...`);
                                        (async () => {
                                            for (let attempt = 0; attempt < 10; attempt++) {
                                                await new Promise(r => setTimeout(r, 3000));
                                                try {
                                                    await indexJob(client, job.factory_address, job.job_id, job.factory_type as 'ton' | 'usdt');
                                                    // Check if state changed
                                                    const { data: updated } = await sb.from('jobs').select('state').eq('address', matchAddr).single();
                                                    if (updated && updated.state !== job.state) {
                                                        log(`SSE quick-poll: ${job.factory_type.toUpperCase()} #${job.job_id} state changed ${job.state} → ${updated.state}`);
                                                        return;
                                                    }
                                                } catch {}
                                            }
                                        })().catch(() => {});
                                    }
                                } else {
                                    // confirmed/finalized — index immediately
                                    let matchAddr = account;
                                    try { matchAddr = Address.parse(tx.account).toString({ bounceable: true }); } catch {}
                                    const { data: job } = await sb.from('jobs').select('job_id, factory_type, factory_address').eq('address', matchAddr).single();
                                    if (job) {
                                        await indexJob(client, job.factory_address, job.job_id, job.factory_type as 'ton' | 'usdt');
                                        log(`SSE: ${job.factory_type.toUpperCase()} #${job.job_id} updated [${finality}]`);
                                    }
                                }
                            }
                        }
                    } catch {}
                }
            }
        } catch (err: any) {
            if (err.name === 'AbortError') {
                log('SSE reconnecting (new addresses)...');
            } else {
                log(`SSE err: ${err.message}`);
            }
        }
        await new Promise(r => setTimeout(r, 2000));
    }
}

// ─── Fallback poller ───

async function fallbackPoller() {
    const client = getClient();
    const sb = getSupabase();
    if (!sb) return;

    while (true) {
        await new Promise(r => setTimeout(r, 60_000)); // Every 60s as safety net
        try {
            for (const { factory, type } of [
                { factory: FACTORY, type: 'ton' as const },
                { factory: JETTON_FACTORY, type: 'usdt' as const },
            ]) {
                const countResult = await client.runMethod(Address.parse(factory), 'get_next_job_id');
                const count = countResult.stack.readNumber();
                const state = await sb.from('indexer_state').select('last_job_count').eq('factory_address', factory).single();
                const lastCount = state?.data?.last_job_count ?? 0;
                if (count > lastCount) {
                    log(`Fallback: ${type.toUpperCase()} ${count - lastCount} new job(s)`);
                    for (let i = lastCount; i < count; i++) {
                        await indexJob(client, factory, i, type);
                    }
                    await sb.from('indexer_state').upsert({
                        factory_address: factory, last_job_count: count,
                        updated_at: new Date().toISOString(),
                    }, { onConflict: 'factory_address' });
                }
            }
        } catch (err: any) {
            log(`Fallback err: ${err.message}`);
        }
    }
}

// ─── Public API ───

export async function startIndexer() {
    const sb = getSupabase();
    if (!sb) { log('Supabase not configured'); return; }
    log(`Indexer starting... Supabase: ${process.env.SUPABASE_URL?.slice(0, 30)}...`);

    const { error: testErr } = await sb.from('jobs').select('id').limit(1);
    if (testErr) { log(`Supabase FAILED: ${testErr.message}`); return; }
    log('Supabase OK');

    await backfill();
    connectSSE().catch(err => log(`SSE crashed: ${err.message}`));
    fallbackPoller().catch(err => log(`Fallback crashed: ${err.message}`));
    log('Indexer running — SSE + 60s fallback');
}
