/**
 * ENACT Protocol Indexer — runs inside the bot process.
 * Backfills all jobs on startup, then uses TON HTTP API v3
 * with fast polling (2s) for near-realtime transaction tracking.
 * Writes to Supabase with tx_status (pending → confirmed → finalized).
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
const V3_BASE = 'https://toncenter.com/api/v3';
const POLL_MS = 2000; // 2 second fast poll

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

// ─── V3 API Transaction Fetching ───

async function fetchTxsV3(address: string, startUtime?: number): Promise<any[]> {
    try {
        let url = `${V3_BASE}/transactions?account=${encodeURIComponent(address)}&limit=50&sort=desc`;
        if (startUtime) url += `&start_utime=${startUtime}`;
        if (API_KEY) url += `&api_key=${API_KEY}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) return [];
        const data = await res.json() as { transactions?: any[] };
        return data.transactions ?? [];
    } catch { return []; }
}

// ─── Job Indexing ───

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

        // Fetch txs via v3 API
        const rawTxs = await fetchTxsV3(jobAddr);
        const txs = rawTxs.map((tx: any) => ({
            hash: tx.hash ? Buffer.from(tx.hash, 'base64').toString('hex') : '',
            fee: (Number(tx.total_fees || 0) / 1e9).toFixed(4),
            utime: tx.now || 0,
            from: tx.in_msg?.source || null,
        }));

        const effectiveCreatedAt = createdAt || (txs.length > 0 ? txs[txs.length - 1].utime : 0);

        // Upsert job
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

        // Upsert transactions
        for (const tx of txs) {
            if (!tx.hash) continue;
            const { error: txErr } = await sb.from('transactions').upsert({
                job_address: jobAddr, tx_hash: tx.hash, fee: tx.fee,
                utime: tx.utime, from_address: tx.from,
            }, { onConflict: 'tx_hash' });
            if (txErr) log(`  DB ERROR tx: ${txErr.message}`);
        }

        // Activity events
        const chronTxs = [...txs].reverse();
        const isUsdt = type === 'usdt';
        const clientStr = clientAddr.toString(uf);
        const providerStr = providerAddr?.toString(uf) ?? null;
        const evaluatorStr = evaluatorAddr.toString(uf);

        const addActivity = async (event: string, status: string, time: number, amount: string | null, from: string | null, txHash: string | null) => {
            const { data: ex } = await sb.from('activity_events').select('id').eq('job_address', jobAddr).eq('event', event).limit(1);
            if (ex && ex.length > 0) return;
            const { error: actErr } = await sb.from('activity_events').insert({
                job_id: jobId, factory_type: type, job_address: jobAddr,
                event, status, time, amount, from_address: from, tx_hash: txHash,
            });
            if (actErr) log(`  DB ERROR activity: ${actErr.message}`);
        };

        if (effectiveCreatedAt && chronTxs[0]) await addActivity('Created', 'OPEN', chronTxs[0].utime || effectiveCreatedAt, budgetFormatted, clientStr, chronTxs[0].hash);
        const fundIdx = isUsdt ? 2 : 1;
        if (state >= 1 && chronTxs[fundIdx]) await addActivity('Funded', 'FUNDED', chronTxs[fundIdx].utime, budgetFormatted, clientStr, chronTxs[fundIdx].hash);
        if (submittedAt) {
            const subIdx = isUsdt ? 3 : 2;
            if (providerStr && chronTxs[subIdx]) await addActivity('Taken', 'FUNDED', chronTxs[subIdx].utime - 1, null, providerStr, chronTxs[subIdx].hash);
            if (chronTxs[subIdx]) await addActivity('Submitted', 'SUBMITTED', chronTxs[subIdx].utime, budgetFormatted, providerStr, chronTxs[subIdx].hash);
        }
        const lastTx = chronTxs[chronTxs.length - 1];
        if (stateName === 'COMPLETED' && lastTx) await addActivity('Approved', 'COMPLETED', lastTx.utime, `${budgetFormatted} → Provider`, evaluatorStr, lastTx.hash);
        if (stateName === 'CANCELLED' && lastTx) await addActivity('Cancelled', 'CANCELLED', lastTx.utime, `${budgetFormatted} → Client`, clientStr, lastTx.hash);
        if (stateName === 'DISPUTED' && lastTx) await addActivity('Rejected', 'DISPUTED', lastTx.utime, budgetFormatted, evaluatorStr, lastTx.hash);

        log(`${type.toUpperCase()} #${jobId} ${stateName} indexed`);
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

// ─── Fast Poller via TON HTTP API v3 ───

async function startFastPoller(factory: string, type: 'ton' | 'usdt') {
    const client = getClient();
    const sb = getSupabase();
    if (!sb) return;

    let lastUtime = Math.floor(Date.now() / 1000); // Start from now
    let lastJobCount = 0;

    // Get initial job count
    try {
        const state = await sb.from('indexer_state').select('last_job_count').eq('factory_address', factory).single();
        lastJobCount = state?.data?.last_job_count ?? 0;
    } catch {}

    log(`${type.toUpperCase()} fast poller started (every ${POLL_MS}ms)`);

    while (true) {
        try {
            // 1. Check for new jobs via factory
            const countResult = await client.runMethod(Address.parse(factory), 'get_next_job_id');
            const currentCount = countResult.stack.readNumber();

            if (currentCount > lastJobCount) {
                log(`${type.toUpperCase()}: ${currentCount - lastJobCount} new job(s)!`);
                for (let i = lastJobCount; i < currentCount; i++) {
                    await indexJob(client, factory, i, type);
                }
                lastJobCount = currentCount;
                await sb.from('indexer_state').upsert({
                    factory_address: factory, last_job_count: currentCount,
                    updated_at: new Date().toISOString(),
                }, { onConflict: 'factory_address' });
            }

            // 2. Check active jobs for state changes via v3 API
            const { data: activeJobs } = await sb.from('jobs')
                .select('job_id, address, factory_type')
                .eq('factory_address', factory)
                .in('state', [0, 1, 2]);

            if (activeJobs && activeJobs.length > 0) {
                for (const job of activeJobs) {
                    // Quick check: any new txs since last poll?
                    const newTxs = await fetchTxsV3(job.address, lastUtime - 5);
                    if (newTxs.length > 0) {
                        log(`${type.toUpperCase()} #${job.job_id}: ${newTxs.length} new tx(s), re-indexing...`);
                        await indexJob(client, factory, job.job_id, type);
                    }
                }
            }

            lastUtime = Math.floor(Date.now() / 1000);
        } catch (err: any) {
            log(`Poller error ${type}: ${err.message}`);
        }

        await new Promise(r => setTimeout(r, POLL_MS));
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
    log(`Service key: ${process.env.SUPABASE_SERVICE_KEY ? 'set (' + process.env.SUPABASE_SERVICE_KEY.slice(0, 10) + '...)' : 'NOT SET'}`);

    // Test connection
    const { error: testErr } = await sb.from('jobs').select('id').limit(1);
    if (testErr) {
        log(`Supabase connection FAILED: ${testErr.message}`);
        return;
    }
    log('Supabase connection OK');

    // Backfill
    await backfill();

    // Start fast pollers (2s interval)
    startFastPoller(FACTORY, 'ton').catch(err => log(`TON poller crashed: ${err.message}`));
    startFastPoller(JETTON_FACTORY, 'usdt').catch(err => log(`USDT poller crashed: ${err.message}`));

    log('Indexer running — fast polling every 2s');
}
