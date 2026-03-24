/**
 * ENACT Protocol Indexer
 * WebSocket streaming (primary) + polling fallback (120s)
 * Writes to Supabase. All other services read from Supabase.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { TonClient } from '@ton/ton';
import { Address } from '@ton/core';
import WebSocket from 'ws';

const FACTORY = 'EQAFHodWCzrYJTbrbJp1lMDQLfypTHoJCd0UcerjsdxPECjX';
const JETTON_FACTORY = 'EQCgYmwi8uwrG7I6bI3Cdv0ct-bAB1jZ0DQ7C3dX3MYn6VTj';
const STATE_NAMES = ['OPEN', 'FUNDED', 'SUBMITTED', 'COMPLETED', 'DISPUTED', 'CANCELLED'];
const ZERO_HASH = '0'.repeat(64);
const API_KEY = process.env.TONCENTER_API_KEY || '';
const IPFS_GW = 'https://ipfs.io/ipfs';
const WS_URL = `wss://toncenter.com/api/streaming/v2/ws${API_KEY ? '?api_key=' + API_KEY : ''}`;

let supabase: SupabaseClient | null = null;
let client: TonClient | null = null;

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
    if (client) return client;
    client = new TonClient({
        endpoint: process.env.TON_ENDPOINT || 'https://toncenter.com/api/v2/jsonRPC',
        apiKey: API_KEY,
    });
    return client;
}

// ─── IPFS Content Resolution ───

async function fetchFromIPFS(cid: string): Promise<any> {
    const gateways = [IPFS_GW, 'https://dweb.link/ipfs', 'https://cloudflare-ipfs.com/ipfs'];
    for (const gw of gateways) {
        try {
            const res = await fetch(`${gw}/${cid}`, { signal: AbortSignal.timeout(8000) });
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
                let fileFallback: { cid: string; filename: string } | null = null;
                for (const pin of (pins.rows ?? [])) {
                    const kv = pin.metadata?.keyvalues;
                    if (kv?.type === 'file') { fileFallback = { cid: pin.ipfs_pin_hash, filename: kv.filename || 'file' }; continue; }
                    const data = await fetchFromIPFS(pin.ipfs_pin_hash);
                    if (data) {
                        return { text: data.description ?? data.result ?? data.reason ?? null, ipfsUrl: `${IPFS_GW}/${pin.ipfs_pin_hash}`, fileCid: data.file?.cid || null, fileName: data.file?.filename || null };
                    }
                }
                if (fileFallback) return { text: null, ipfsUrl: `${IPFS_GW}/${fileFallback.cid}`, fileCid: fileFallback.cid, fileName: fileFallback.filename };
            }
        } catch {}
    }
    return { text: null, ipfsUrl: null, fileCid: null, fileName: null };
}

// ─── Transaction Fetching (with retry + backoff) ───

async function fetchTransactions(address: string): Promise<any[]> {
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const url = `https://toncenter.com/api/v2/getTransactions?address=${encodeURIComponent(address)}&limit=20&archival=true${API_KEY ? `&api_key=${API_KEY}` : ''}`;
            const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
            if (res.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
            if (!res.ok) return [];
            const data = await res.json() as { ok: boolean; result?: any[] };
            return data.ok ? (data.result ?? []) : [];
        } catch {
            if (attempt < 2) await sleep(1000 * (attempt + 1));
        }
    }
    return [];
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ─── Job Indexing ───

async function indexJob(c: TonClient, factory: string, jobId: number, type: 'ton' | 'usdt', force = false) {
    const sb = getSupabase();
    if (!sb) return;

    try {
        const t0 = Date.now();
        // Try Supabase first for address (saves 1 RPC)
        let jobAddr: string;
        const { data: cached } = await sb.from('jobs').select('address').eq('factory_address', factory).eq('job_id', jobId).single();
        if (cached?.address) {
            jobAddr = cached.address;
            log(`  [CACHE] getJobAddress +${Date.now()-t0}ms`);
        } else {
            const addrResult = await c.runMethod(Address.parse(factory), 'get_job_address', [{ type: 'int', value: BigInt(jobId) }]);
            jobAddr = addrResult.stack.readAddress().toString();
            log(`  [RPC] getJobAddress +${Date.now()-t0}ms`);
        }

        if (!force) {
            const { data: existing } = await sb.from('jobs').select('state, description_text').eq('address', jobAddr).single();
            if (existing && [3, 4, 5].includes(existing.state)) return;
        }

        const result = await c.runMethod(Address.parse(jobAddr), 'get_job_data');
        log(`  [RPC] getJobData +${Date.now()-t0}ms`);
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
        const budgetFormatted = type === 'usdt' ? `${(budgetNum / 1e6).toFixed(2)} USDT` : `${(budgetNum / 1e9).toFixed(2)} TON`;
        const descHashHex = descHash.toString(16).padStart(64, '0');
        const resultHashHex = resultHash.toString(16).padStart(64, '0');

        // Only resolve IPFS if text is not already in Supabase
        const { data: existingContent } = await sb.from('jobs').select('description_text, result_text').eq('address', jobAddr).single();
        const needDesc = !existingContent?.description_text && descHashHex !== ZERO_HASH;
        const needResult = !existingContent?.result_text && resultHashHex !== ZERO_HASH;

        const ipfsT0 = Date.now();
        const [descContent, resultContent] = await Promise.all([
            needDesc ? resolveContent(descHashHex) : Promise.resolve({ text: existingContent?.description_text, ipfsUrl: null, fileCid: null, fileName: null }),
            needResult ? resolveContent(resultHashHex) : Promise.resolve({ text: existingContent?.result_text, ipfsUrl: null, fileCid: null, fileName: null }),
        ]);
        if (needDesc || needResult) log(`  [IPFS] Resolve +${Date.now()-ipfsT0}ms (desc=${needDesc} res=${needResult})`);

        const txT0 = Date.now();
        const rawTxs = await fetchTransactions(jobAddr);
        log(`  [RPC] getTransactions +${Date.now()-txT0}ms (${rawTxs.length} txs)`);
        const txs = rawTxs.map((tx: any) => ({
            hash: tx.transaction_id?.hash ? Buffer.from(tx.transaction_id.hash, 'base64').toString('hex') : '',
            fee: (Number(tx.fee || 0) / 1e9).toFixed(4),
            utime: tx.utime || 0,
        }));

        const effectiveCreatedAt = createdAt || (txs.length > 0 ? txs[txs.length - 1].utime : 0);

        // Build upsert — never overwrite content with null
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
        if (descContent.text !== null) jobData.description_text = descContent.text;
        if (descContent.ipfsUrl !== null) jobData.description_ipfs_url = descContent.ipfsUrl;
        if (descContent.fileCid !== null) jobData.description_file_cid = descContent.fileCid;
        if (descContent.fileName !== null) jobData.description_file_name = descContent.fileName;
        if (resultContent.text !== null) jobData.result_text = resultContent.text;
        if (resultContent.ipfsUrl !== null) jobData.result_ipfs_url = resultContent.ipfsUrl;
        if (resultContent.fileCid !== null) jobData.result_file_cid = resultContent.fileCid;
        if (resultContent.fileName !== null) jobData.result_file_name = resultContent.fileName;

        await sb.from('jobs').upsert(jobData, { onConflict: 'address' });
        log(`  [DB] Upserted job +${Date.now()-t0}ms`);

        // Transactions
        for (const tx of txs) {
            if (!tx.hash) continue;
            await sb.from('transactions').upsert({ job_address: jobAddr, tx_hash: tx.hash, fee: tx.fee, utime: tx.utime }, { onConflict: 'tx_hash' });
        }

        // Activity events (simplified — only add if not exists)
        const chronTxs = [...txs].reverse();
        const clientStr = clientAddr.toString(uf);
        const providerStr = providerAddr?.toString(uf) ?? null;
        const evaluatorStr = evaluatorAddr.toString(uf);
        const isUsdt = type === 'usdt';
        const addAct = async (event: string, status: string, time: number, amount: string | null, from: string | null, txHash: string | null) => {
            const { data: ex } = await sb.from('activity_events').select('id').eq('job_address', jobAddr).eq('event', event).limit(1);
            if (ex && ex.length > 0) return;
            await sb.from('activity_events').insert({ job_id: jobId, factory_type: type, job_address: jobAddr, event, status, time, amount, from_address: from, tx_hash: txHash });
        };

        if (effectiveCreatedAt && chronTxs[0]) await addAct('Created', 'OPEN', chronTxs[0].utime || effectiveCreatedAt, budgetFormatted, clientStr, chronTxs[0].hash);
        const fundIdx = isUsdt ? 2 : 1;
        if (state >= 1 && chronTxs[fundIdx]) await addAct('Funded', 'FUNDED', chronTxs[fundIdx].utime, budgetFormatted, clientStr, chronTxs[fundIdx].hash);
        const takeBase = isUsdt ? 3 : 2;
        if (providerStr && chronTxs[takeBase]) await addAct('Taken', 'FUNDED', chronTxs[takeBase].utime, null, providerStr, chronTxs[takeBase].hash);
        const subIdx = providerStr ? takeBase + 1 : takeBase;
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

// ─── Backfill (only jobs missing content) ───

async function backfill() {
    const c = getClient();
    const sb = getSupabase();
    if (!sb) return;

    for (const { factory, type } of [
        { factory: FACTORY, type: 'ton' as const },
        { factory: JETTON_FACTORY, type: 'usdt' as const },
    ]) {
        try {
            const countResult = await c.runMethod(Address.parse(factory), 'get_next_job_id');
            const count = countResult.stack.readNumber();
            log(`Backfill ${type.toUpperCase()}: ${count} jobs`);

            for (let i = 0; i < count; i++) {
                // Only index if not already fully indexed
                const addrResult = await c.runMethod(Address.parse(factory), 'get_job_address', [{ type: 'int', value: BigInt(i) }]);
                const jobAddr = addrResult.stack.readAddress().toString();
                const { data: existing } = await sb.from('jobs').select('state, description_text').eq('address', jobAddr).single();

                if (existing && [3, 4, 5].includes(existing.state) && existing.description_text) {
                    continue; // Terminal + has content = skip
                }

                await indexJob(c, factory, i, type, true);
                await sleep(1500);
            }

            await sb.from('indexer_state').upsert({ factory_address: factory, last_job_count: count, updated_at: new Date().toISOString() }, { onConflict: 'factory_address' });
        } catch (err: any) {
            log(`Backfill ${type} err: ${err.message}`);
        }
    }
    log('Backfill done');
}

// ─── WebSocket Streaming ───

let wsReconnectDelay = 1000;
let trackedAddresses: string[] = [];

async function refreshTrackedAddresses() {
    const sb = getSupabase();
    if (!sb) return;

    // Factories + all active job addresses
    const addrs = new Set<string>();
    addrs.add(Address.parse(FACTORY).toRawString());
    addrs.add(Address.parse(JETTON_FACTORY).toRawString());

    const { data: jobs } = await sb.from('jobs').select('address').in('state_name', ['OPEN', 'FUNDED', 'SUBMITTED']);
    if (jobs) {
        for (const j of jobs) {
            try { addrs.add(Address.parse(j.address).toRawString()); } catch {}
        }
    }

    trackedAddresses = [...addrs];
}

function connectWebSocket() {
    const sb = getSupabase();
    const c = getClient();
    if (!sb) return;

    const ws = new WebSocket(WS_URL);
    let pingInterval: NodeJS.Timeout | null = null;

    ws.on('open', async () => {
        log(`WS connected`);
        wsReconnectDelay = 1000; // Reset backoff
        pingInterval = setInterval(() => ws.ping(), 15000);

        await refreshTrackedAddresses();
        ws.send(JSON.stringify({
            operation: 'subscribe', id: 'enact-idx',
            addresses: trackedAddresses,
            types: ['transactions'],
            min_finality: 'finalized',
        }));
        log(`WS subscribed to ${trackedAddresses.length} addresses (finalized only)`);
    });

    ws.on('message', async (raw: Buffer) => {
        try {
            const data = JSON.parse(raw.toString());
            if (data.id) return; // subscription confirmation
            if (data.error) { log(`WS error: ${JSON.stringify(data.error)}`); return; }

            if (data.type === 'transactions' && data.finality === 'finalized' && data.transactions) {
                for (const tx of data.transactions) {
                    const account = tx.account;
                    if (!account) continue;
                    const t0 = Date.now();
                    log(`[WS] Event received: account=${account.slice(0, 16)}... t=${t0}`);

                    const accountLower = account.toLowerCase();
                    const rawFactory = Address.parse(FACTORY).toRawString().toLowerCase();
                    const rawJettonFactory = Address.parse(JETTON_FACTORY).toRawString().toLowerCase();

                    if (accountLower === rawFactory || accountLower === rawJettonFactory) {
                        const type = accountLower === rawFactory ? 'ton' : 'usdt';
                        const factory = accountLower === rawFactory ? FACTORY : JETTON_FACTORY;
                        log(`[WS] Factory tx (${type}) — checking new jobs t=${Date.now()} (+${Date.now()-t0}ms)`);
                        try {
                            const { data: state } = await sb.from('indexer_state').select('last_job_count').eq('factory_address', factory).single();
                            const lastCount = state?.last_job_count ?? 0;
                            // Retry up to 5 times — factory may not have incremented yet
                            let count = lastCount;
                            for (let r = 0; r < 5; r++) {
                                const countResult = await c.runMethod(Address.parse(factory), 'get_next_job_id');
                                count = countResult.stack.readNumber();
                                if (count > lastCount) break;
                                log(`[WS] Count unchanged (${count}), retrying in 3s... (+${Date.now()-t0}ms)`);
                                await sleep(3000);
                            }
                            if (count > lastCount) {
                                for (let i = lastCount; i < count; i++) {
                                    log(`[IDX] indexJob start ${type}#${i} t=${Date.now()} (+${Date.now()-t0}ms)`);
                                    await indexJob(c, factory, i, type);
                                    log(`[IDX] indexJob done ${type}#${i} t=${Date.now()} (+${Date.now()-t0}ms)`);
                                }
                                await sb.from('indexer_state').upsert({ factory_address: factory, last_job_count: count, updated_at: new Date().toISOString() }, { onConflict: 'factory_address' });
                                await refreshTrackedAddresses();
                                ws.send(JSON.stringify({ operation: 'subscribe', id: 'enact-idx-update', addresses: trackedAddresses, types: ['transactions'], min_finality: 'finalized' }));
                                log(`[WS] Resubscribed ${trackedAddresses.length} addrs t=${Date.now()} (+${Date.now()-t0}ms)`);
                            }
                        } catch (err: any) { log(`[WS] Factory err: ${err.message}`); }
                    } else {
                        let friendlyAddr: string;
                        try { friendlyAddr = Address.parse(account).toString(); } catch { continue; }
                        const { data: job } = await sb.from('jobs').select('job_id, factory_address, factory_type').eq('address', friendlyAddr).single();
                        if (job) {
                            log(`[IDX] Re-index ${job.factory_type}#${job.job_id} start t=${Date.now()} (+${Date.now()-t0}ms)`);
                            await indexJob(c, job.factory_address, job.job_id, job.factory_type as 'ton' | 'usdt');
                            log(`[DB] Done ${job.factory_type}#${job.job_id} t=${Date.now()} (+${Date.now()-t0}ms)`);
                        }
                    }
                }
            }
        } catch (err: any) {
            log(`WS message err: ${err.message}`);
        }
    });

    ws.on('error', (err: Error) => log(`WS error: ${err.message}`));

    ws.on('close', (code: number) => {
        if (pingInterval) clearInterval(pingInterval);
        log(`WS closed (${code}). Reconnecting in ${wsReconnectDelay / 1000}s...`);
        setTimeout(connectWebSocket, wsReconnectDelay);
        wsReconnectDelay = Math.min(wsReconnectDelay * 2, 30000); // Exponential backoff, max 30s
    });
}

// ─── Polling Fallback (120s, only active jobs) ───

async function poller() {
    const c = getClient();
    const sb = getSupabase();
    if (!sb) return;

    while (true) {
        await sleep(120_000);
        try {
            for (const { factory, type } of [
                { factory: FACTORY, type: 'ton' as const },
                { factory: JETTON_FACTORY, type: 'usdt' as const },
            ]) {
                // New jobs
                const countResult = await c.runMethod(Address.parse(factory), 'get_next_job_id');
                const count = countResult.stack.readNumber();
                const { data: state } = await sb.from('indexer_state').select('last_job_count').eq('factory_address', factory).single();
                const lastCount = state?.last_job_count ?? 0;
                if (count > lastCount) {
                    log(`Poll: ${type.toUpperCase()} ${count - lastCount} new job(s)`);
                    for (let i = lastCount; i < count; i++) await indexJob(c, factory, i, type);
                    await sb.from('indexer_state').upsert({ factory_address: factory, last_job_count: count, updated_at: new Date().toISOString() }, { onConflict: 'factory_address' });
                }

                // Active jobs only
                const { data: activeJobs } = await sb.from('jobs').select('job_id, factory_address, factory_type').eq('factory_address', factory).in('state_name', ['OPEN', 'FUNDED', 'SUBMITTED']);
                if (activeJobs) {
                    for (const aj of activeJobs) await indexJob(c, aj.factory_address, aj.job_id, aj.factory_type as 'ton' | 'usdt');
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

    await backfill();

    // WebSocket streaming (primary)
    if (API_KEY) {
        connectWebSocket();
        log('WebSocket streaming started');
    } else {
        log('No API key — WebSocket disabled, polling only');
    }

    // Polling fallback (120s)
    poller().catch(err => log(`Poller crashed: ${err.message}`));
    log('Indexer running — WS streaming + 120s polling fallback');
}
