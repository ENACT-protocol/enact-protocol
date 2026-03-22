/**
 * ENACT Protocol Indexer — runs inside the bot process.
 * Polls blockchain every 60s, writes to Supabase.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { TonClient } from '@ton/ton';
import { Address } from '@ton/core';

const FACTORY = 'EQAFHodWCzrYJTbrbJp1lMDQLfypTHoJCd0UcerjsdxPECjX';
const JETTON_FACTORY = 'EQCgYmwi8uwrG7I6bI3Cdv0ct-bAB1jZ0DQ7C3dX3MYn6VTj';
const STATE_NAMES = ['OPEN', 'FUNDED', 'SUBMITTED', 'COMPLETED', 'DISPUTED', 'CANCELLED'];
const ZERO_HASH = '0'.repeat(64);
const API_KEY = process.env.TONCENTER_API_KEY || '';
const IPFS_GW = 'https://ipfs.io/ipfs';

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
    return new TonClient({
        endpoint: process.env.TON_ENDPOINT || 'https://toncenter.com/api/v2/jsonRPC',
        apiKey: API_KEY,
    });
}

// ─── IPFS Content Resolution ───

async function fetchFromIPFS(cid: string): Promise<any> {
    const gateways = [IPFS_GW, 'https://dweb.link/ipfs', 'https://cloudflare-ipfs.com/ipfs', 'https://w3s.link/ipfs'];
    for (const gw of gateways) {
        try {
            const res = await fetch(`${gw}/${cid}`, { signal: AbortSignal.timeout(5000) });
            if (res.ok) return await res.json();
        } catch {}
    }
    return null;
}

async function resolveContent(hash: string): Promise<{ text: string | null; ipfsUrl: string | null; fileCid: string | null; fileName: string | null }> {
    if (!hash || hash === ZERO_HASH) return { text: null, ipfsUrl: null, fileCid: null, fileName: null };
    try {
        const clean = hash.replace(/0+$/, '');
        if (clean.length >= 4) {
            const bytes = Buffer.from(clean, 'hex').toString('utf-8').replace(/\0/g, '');
            if (/^[\x20-\x7E\n\r\t]+$/.test(bytes) && bytes.length > 2) return { text: bytes, ipfsUrl: null, fileCid: null, fileName: null };
        }
    } catch {}
    if (process.env.PINATA_JWT) {
        try {
            const url = `https://api.pinata.cloud/data/pinList?status=pinned&pageLimit=5&metadata[keyvalues]={"descHash":{"value":"${hash}","op":"eq"}}`;
            const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.PINATA_JWT}` }, signal: AbortSignal.timeout(8000) });
            if (res.ok) {
                const pins = await res.json() as { rows: Array<{ ipfs_pin_hash: string; metadata?: { keyvalues?: Record<string, string> } }> };
                // Prefer JSON over file pins
                let fileFallback: { cid: string; filename: string } | null = null;
                for (const pin of (pins.rows ?? [])) {
                    const kv = pin.metadata?.keyvalues;
                    const cid = pin.ipfs_pin_hash;
                    if (kv?.type === 'file') {
                        fileFallback = { cid, filename: kv.filename || 'file' };
                        continue;
                    }
                    const data = await fetchFromIPFS(cid);
                    if (data) {
                        const text = data.description ?? data.result ?? data.reason ?? null;
                        const fileCid = data.file?.cid || null;
                        const fileName = data.file?.filename || null;
                        return { text, ipfsUrl: `${IPFS_GW}/${cid}`, fileCid, fileName };
                    }
                }
                if (fileFallback) {
                    return { text: null, ipfsUrl: `${IPFS_GW}/${fileFallback.cid}`, fileCid: fileFallback.cid, fileName: fileFallback.filename };
                }
            }
        } catch {}
    }
    return { text: null, ipfsUrl: null, fileCid: null, fileName: null };
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

// ─── Job Indexing ───

async function indexJob(client: TonClient, factory: string, jobId: number, type: 'ton' | 'usdt', force = false) {
    const sb = getSupabase();
    if (!sb) return;

    try {
        const addrResult = await client.runMethod(Address.parse(factory), 'get_job_address', [
            { type: 'int', value: BigInt(jobId) },
        ]);
        const jobAddr = addrResult.stack.readAddress().toString();

        // Skip terminal jobs already indexed (unless force re-index)
        if (!force) {
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
            state >= 3 ? resolveContent(reason.toString(16).padStart(64, '0')) : Promise.resolve({ text: null, ipfsUrl: null, fileCid: null, fileName: null }),
        ]);

        const rawTxs = await fetchTransactions(jobAddr);
        const txs = rawTxs.map((tx: any) => ({
            hash: tx.transaction_id?.hash ? Buffer.from(tx.transaction_id.hash, 'base64').toString('hex') : '',
            fee: (Number(tx.fee || 0) / 1e9).toFixed(4),
            utime: tx.utime || 0,
        }));

        const effectiveCreatedAt = createdAt || (txs.length > 0 ? txs[txs.length - 1].utime : 0);

        // Build upsert data — never overwrite existing content with null
        const jobData: Record<string, any> = {
            job_id: jobId, factory_type: type, address: jobAddr, factory_address: factory,
            state, state_name: stateName,
            client: clientAddr.toString(uf), provider: providerAddr?.toString(uf) ?? null,
            evaluator: evaluatorAddr.toString(uf), budget: budgetNum, budget_formatted: budgetFormatted,
            desc_hash: descHashHex, result_hash: resultHashHex,
            timeout, created_at: effectiveCreatedAt, eval_timeout: evalTimeout,
            submitted_at: submittedAt, result_type: resultType,
            updated_at: new Date().toISOString(),
        };
        // Only set content fields if we resolved something (don't overwrite with null)
        if (descContent.text !== null) jobData.description_text = descContent.text;
        if (descContent.ipfsUrl !== null) jobData.description_ipfs_url = descContent.ipfsUrl;
        if (descContent.fileCid !== null) jobData.description_file_cid = descContent.fileCid;
        if (descContent.fileName !== null) jobData.description_file_name = descContent.fileName;
        if (resultContent.text !== null) jobData.result_text = resultContent.text;
        if (resultContent.ipfsUrl !== null) jobData.result_ipfs_url = resultContent.ipfsUrl;
        if (resultContent.fileCid !== null) jobData.result_file_cid = resultContent.fileCid;
        if (resultContent.fileName !== null) jobData.result_file_name = resultContent.fileName;
        if (reasonContent.text !== null) jobData.reason_text = reasonContent.text;

        const { error: jobErr } = await sb.from('jobs').upsert(jobData, { onConflict: 'address' });
        if (jobErr) log(`  DB ERR jobs: ${jobErr.message}`);

        for (const tx of txs) {
            if (!tx.hash) continue;
            await sb.from('transactions').upsert({
                job_address: jobAddr, tx_hash: tx.hash, fee: tx.fee, utime: tx.utime,
            }, { onConflict: 'tx_hash' });
        }

        // Activity events
        const chronTxs = [...txs].reverse();
        const clientStr = clientAddr.toString(uf);
        const providerStr = providerAddr?.toString(uf) ?? null;
        const evaluatorStr = evaluatorAddr.toString(uf);
        const isUsdt = type === 'usdt';
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
        const termIdx = submittedAt ? subIdx + 1 : takeBase + 1;
        if (stateName === 'COMPLETED' && chronTxs[termIdx]) await addAct('Approved', 'COMPLETED', chronTxs[termIdx].utime, `${budgetFormatted} → Provider`, evaluatorStr, chronTxs[termIdx].hash);
        if (stateName === 'DISPUTED' && chronTxs[termIdx]) await addAct('Rejected', 'DISPUTED', chronTxs[termIdx].utime, budgetFormatted, evaluatorStr, chronTxs[termIdx].hash);
        if (stateName === 'CANCELLED') {
            const lastTx = chronTxs[chronTxs.length - 1];
            if (lastTx) await addAct('Cancelled', 'CANCELLED', lastTx.utime, `${budgetFormatted} → Client`, clientStr, lastTx.hash);
        }

    } catch (err: any) {
        log(`  indexJob ${type}#${jobId} err: ${err.message}`);
    }
}

// ─── Backfill ───

async function backfill() {
    const client = getClient();
    const sb = getSupabase();
    if (!sb) return;

    for (const { factory, type } of [
        { factory: FACTORY, type: 'ton' as const },
        { factory: JETTON_FACTORY, type: 'usdt' as const },
    ]) {
        try {
            const countResult = await client.runMethod(Address.parse(factory), 'get_next_job_id');
            const count = countResult.stack.readNumber();
            log(`Backfill ${type.toUpperCase()}: ${count} jobs`);
            for (let i = 0; i < count; i++) {
                await indexJob(client, factory, i, type, true); // force to populate new columns
            }
            await sb.from('indexer_state').upsert({
                factory_address: factory, last_job_count: count,
                updated_at: new Date().toISOString(),
            }, { onConflict: 'factory_address' });
        } catch (err: any) {
            log(`Backfill ${type} err: ${err.message}`);
        }
    }
    log('Backfill done');
}

// ─── Polling (every 60s) ───

async function poller() {
    const client = getClient();
    const sb = getSupabase();
    if (!sb) return;

    while (true) {
        await new Promise(r => setTimeout(r, 60_000));
        try {
            for (const { factory, type } of [
                { factory: FACTORY, type: 'ton' as const },
                { factory: JETTON_FACTORY, type: 'usdt' as const },
            ]) {
                // Check for new jobs
                const countResult = await client.runMethod(Address.parse(factory), 'get_next_job_id');
                const count = countResult.stack.readNumber();
                const state = await sb.from('indexer_state').select('last_job_count').eq('factory_address', factory).single();
                const lastCount = state?.data?.last_job_count ?? 0;
                if (count > lastCount) {
                    log(`Poll: ${type.toUpperCase()} ${count - lastCount} new job(s)`);
                    for (let i = lastCount; i < count; i++) {
                        await indexJob(client, factory, i, type);
                    }
                    await sb.from('indexer_state').upsert({
                        factory_address: factory, last_job_count: count,
                        updated_at: new Date().toISOString(),
                    }, { onConflict: 'factory_address' });
                }

                // Re-index active jobs only
                const { data: activeJobs } = await sb.from('jobs')
                    .select('job_id, factory_address, factory_type')
                    .eq('factory_address', factory)
                    .in('state_name', ['OPEN', 'FUNDED', 'SUBMITTED']);
                if (activeJobs) {
                    for (const aj of activeJobs) {
                        await indexJob(client, aj.factory_address, aj.job_id, aj.factory_type as 'ton' | 'usdt');
                    }
                }
            }
        } catch (err: any) {
            log(`Poll err: ${err.message}`);
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

    // Clean up old gateway URLs
    for (const col of ['description_ipfs_url', 'result_ipfs_url']) {
        const { data: rows } = await sb.from('jobs').select('id').like(col, '%green-known%');
        if (rows && rows.length > 0) {
            log(`Cleaning ${rows.length} old gateway URLs in ${col}...`);
            for (const row of rows) {
                const { data: full } = await sb.from('jobs').select(col).eq('id', row.id).single();
                if (full) {
                    const oldUrl = (full as any)[col] as string;
                    const newUrl = oldUrl?.replace(/https:\/\/[^/]*mypinata\.cloud\/ipfs/g, IPFS_GW);
                    if (newUrl && newUrl !== oldUrl) await sb.from('jobs').update({ [col]: newUrl }).eq('id', row.id);
                }
            }
        }
    }

    await backfill();
    poller().catch(err => log(`Poller crashed: ${err.message}`));
    log('Indexer running — polling every 60s');
}
