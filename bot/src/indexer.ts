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

// ─── Transaction Fetching (v2 for backfill) ───

async function fetchTransactions(address: string): Promise<any[]> {
    try {
        const url = `https://toncenter.com/api/v2/getTransactions?address=${encodeURIComponent(address)}&limit=20&archival=true${API_KEY ? `&api_key=${API_KEY}` : ''}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) return [];
        const data = await res.json() as { ok: boolean; result?: any[] };
        return data.ok ? (data.result ?? []) : [];
    } catch { return []; }
}

// ─── Job Indexing ───

async function indexJob(client: TonClient, factory: string, jobId: number, type: 'ton' | 'usdt', txStatus: string = 'finalized') {
    const sb = getSupabase();
    if (!sb) return;

    try {
        const addrResult = await client.runMethod(Address.parse(factory), 'get_job_address', [
            { type: 'int', value: BigInt(jobId) },
        ]);
        const jobAddr = addrResult.stack.readAddress().toString();

        // Skip terminal jobs already indexed (unless pending/confirmed update)
        if (txStatus === 'finalized') {
            const { data: existing } = await sb.from('jobs').select('state').eq('address', jobAddr).single();
            if (existing && [3, 4, 5].includes(existing.state)) return;
        }

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
        if (jobErr) log(`  DB ERROR jobs: ${jobErr.message} (${jobErr.code})`);

        for (const tx of txs) {
            if (!tx.hash) continue;
            await sb.from('transactions').upsert({
                job_address: jobAddr, tx_hash: tx.hash, fee: tx.fee,
                utime: tx.utime, from_address: tx.from, tx_status: txStatus,
            }, { onConflict: 'tx_hash' });
        }

        // Activity events
        const chronTxs = [...txs].reverse();
        const isUsdt = type === 'usdt';
        const clientStr = clientAddr.toString(uf);
        const providerStr = providerAddr?.toString(uf) ?? null;
        const evaluatorStr = evaluatorAddr.toString(uf);

        const addActivity = async (event: string, status: string, time: number, amount: string | null, from: string | null, txHash: string | null) => {
            const { data: ex } = await sb.from('activity_events').select('id').eq('job_address', jobAddr).eq('event', event).limit(1);
            if (ex && ex.length > 0) {
                // Update tx_status if event exists
                await sb.from('activity_events').update({ tx_status: txStatus }).eq('job_address', jobAddr).eq('event', event);
                return;
            }
            await sb.from('activity_events').insert({
                job_id: jobId, factory_type: type, job_address: jobAddr,
                event, status, time, amount, from_address: from, tx_hash: txHash, tx_status: txStatus,
            });
        };

        if (effectiveCreatedAt && chronTxs[0]) await addActivity('Created', 'OPEN', chronTxs[0].utime || effectiveCreatedAt, budgetFormatted, clientStr, chronTxs[0].hash);
        const fundIdx = isUsdt ? 2 : 1;
        if (state >= 1 && chronTxs[fundIdx]) await addActivity('Funded', 'FUNDED', chronTxs[fundIdx].utime, budgetFormatted, clientStr, chronTxs[fundIdx].hash);
        // Taken: provider is set (even before submit)
        if (providerStr) {
            // Take tx is right after fund for TON, or after setWallet+fund for USDT
            const takeIdx = isUsdt ? 3 : 2;
            const takeTx = chronTxs[takeIdx];
            if (takeTx) await addActivity('Taken', 'FUNDED', takeTx.utime, null, providerStr, takeTx.hash);
        }
        if (submittedAt) {
            const subIdx = isUsdt ? 3 : 2;
            if (chronTxs[subIdx]) await addActivity('Submitted', 'SUBMITTED', chronTxs[subIdx].utime, budgetFormatted, providerStr, chronTxs[subIdx].hash);
        }
        const lastTx = chronTxs[chronTxs.length - 1];
        if (stateName === 'COMPLETED' && lastTx) await addActivity('Approved', 'COMPLETED', lastTx.utime, `${budgetFormatted} → Provider`, evaluatorStr, lastTx.hash);
        if (stateName === 'CANCELLED' && lastTx) await addActivity('Cancelled', 'CANCELLED', lastTx.utime, `${budgetFormatted} → Client`, clientStr, lastTx.hash);
        if (stateName === 'DISPUTED' && lastTx) await addActivity('Rejected', 'DISPUTED', lastTx.utime, budgetFormatted, evaluatorStr, lastTx.hash);

        log(`${type.toUpperCase()} #${jobId} ${stateName} [${txStatus}]`);
    } catch (err: any) {
        log(`Error indexing ${type} #${jobId}: ${err.message}`);
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
            log(`Backfill error for ${type}: ${err.message}`);
        }
    }
    log('Backfill done.');
}

// ─── SSE Streaming via Toncenter Streaming API v2 ───

// Tracked addresses: both factories + all known job addresses
let trackedAddresses: string[] = [FACTORY, JETTON_FACTORY];

async function refreshTrackedAddresses() {
    const sb = getSupabase();
    if (!sb) return;
    const { data } = await sb.from('jobs').select('address').in('state', [0, 1, 2]);
    const jobAddrs = (data ?? []).map((j: any) => j.address);
    trackedAddresses = [FACTORY, JETTON_FACTORY, ...jobAddrs];
}

async function connectSSE() {
    const client = getClient();
    const sb = getSupabase();
    if (!sb) return;

    while (true) {
        try {
            await refreshTrackedAddresses();
            log(`SSE connecting with ${trackedAddresses.length} addresses...`);

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
            });

            if (!res.ok) {
                log(`SSE connection failed: ${res.status} ${res.statusText}`);
                await new Promise(r => setTimeout(r, 5000));
                continue;
            }

            if (!res.body) {
                log('SSE: no response body');
                await new Promise(r => setTimeout(r, 5000));
                continue;
            }

            log('SSE connected! Listening for transactions...');
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    log('SSE stream ended, reconnecting...');
                    break;
                }

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';

                for (const line of lines) {
                    // Skip keepalive comments
                    if (line.startsWith(':') || line.trim() === '') continue;

                    // SSE data lines start with "data: "
                    if (line.startsWith('data: ')) {
                        const jsonStr = line.slice(6);
                        try {
                            const event = JSON.parse(jsonStr);

                            if (event.type === 'transactions' && event.transactions) {
                                const finality = event.finality || 'finalized';
                                log(`SSE: ${event.transactions.length} tx(s) [${finality}]`);

                                for (const tx of event.transactions) {
                                    // Normalize account address (SSE returns raw 0:... format)
                                    let account = tx.account;
                                    try { account = Address.parse(tx.account).toString(); } catch {}
                                    // Check if this is a factory tx (new job created)
                                    if (account === FACTORY || account === JETTON_FACTORY) {
                                        const type = account === FACTORY ? 'ton' : 'usdt';
                                        const countResult = await client.runMethod(Address.parse(account), 'get_next_job_id');
                                        const count = countResult.stack.readNumber();
                                        const state = await sb.from('indexer_state').select('last_job_count').eq('factory_address', account).single();
                                        const lastCount = state?.data?.last_job_count ?? 0;
                                        if (count > lastCount) {
                                            for (let i = lastCount; i < count; i++) {
                                                await indexJob(client, account, i, type, finality);
                                            }
                                            await sb.from('indexer_state').upsert({
                                                factory_address: account, last_job_count: count,
                                                updated_at: new Date().toISOString(),
                                            }, { onConflict: 'factory_address' });
                                            await refreshTrackedAddresses();
                                        }
                                    } else {
                                        // Job contract tx — re-index this job
                                        // Try both bounceable and non-bounceable formats
                                        let matchAddr = account;
                                        try { matchAddr = Address.parse(tx.account).toString({ bounceable: true }); } catch {}
                                        const { data: job } = await sb.from('jobs').select('job_id, factory_type, factory_address').eq('address', matchAddr).single();
                                        if (job) {
                                            await indexJob(client, job.factory_address, job.job_id, job.factory_type as 'ton' | 'usdt', finality);
                                        }
                                    }
                                }
                            }
                        } catch (parseErr: any) {
                            // Not JSON or parse error — skip
                        }
                    }
                }
            }
        } catch (err: any) {
            log(`SSE error: ${err.message}`);
        }

        // Reconnect after delay
        log('SSE reconnecting in 3s...');
        await new Promise(r => setTimeout(r, 3000));
    }
}

// ─── Fallback poller (in case SSE fails) ───

async function fallbackPoller() {
    const client = getClient();
    const sb = getSupabase();
    if (!sb) return;

    while (true) {
        await new Promise(r => setTimeout(r, 30_000)); // Every 30s as backup
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

                // Re-index active jobs
                const { data: activeJobs } = await sb.from('jobs')
                    .select('job_id, factory_address, factory_type')
                    .eq('factory_address', factory)
                    .in('state', [0, 1, 2]);
                if (activeJobs) {
                    for (const job of activeJobs) {
                        await indexJob(client, factory, job.job_id, type);
                    }
                }
            }
        } catch (err: any) {
            log(`Fallback error: ${err.message}`);
        }
    }
}

// ─── Public API ───

export async function startIndexer() {
    const sb = getSupabase();
    if (!sb) {
        log('Supabase not configured — indexer disabled');
        return;
    }
    log(`Starting indexer... Supabase: ${process.env.SUPABASE_URL?.slice(0, 30)}...`);

    const { error: testErr } = await sb.from('jobs').select('id').limit(1);
    if (testErr) {
        log(`Supabase connection FAILED: ${testErr.message}`);
        return;
    }
    log('Supabase connection OK');

    // Backfill existing data
    await backfill();

    // Start SSE streaming (primary)
    connectSSE().catch(err => log(`SSE crashed: ${err.message}`));

    // Start fallback poller (backup, every 30s)
    fallbackPoller().catch(err => log(`Fallback crashed: ${err.message}`));

    log('Indexer running — SSE streaming + 30s fallback poller');
}
