/**
 * ENACT Protocol Indexer
 * WebSocket streaming (primary) + polling fallback (120s)
 * Writes to Supabase. All other services read from Supabase.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { TonClient } from '@ton/ton';
import { Address, Cell } from '@ton/core';
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

// ─── Opcodes ───

const OP = { FUND: 1, TAKE: 2, SUBMIT: 3, EVALUATE: 4, CANCEL: 5, INIT_JOB: 6, CLAIM: 7, QUIT: 8, SET_BUDGET: 9, SET_JETTON_WALLET: 0x0A, JETTON_NOTIFY: 0x7362d09c };

interface ParsedTx { hash: string; fee: string; utime: number; opcode: number | null; from: string | null; approved?: boolean; }

// ─── Transaction Fetching (with retry + backoff + opcode parsing) ───

async function fetchTransactions(address: string): Promise<ParsedTx[]> {
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const url = `https://toncenter.com/api/v2/getTransactions?address=${encodeURIComponent(address)}&limit=20&archival=true${API_KEY ? `&api_key=${API_KEY}` : ''}`;
            const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
            if (res.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
            if (!res.ok) return [];
            const data = await res.json() as { ok: boolean; result?: any[] };
            if (!data.ok) return [];
            return (data.result ?? [])
                .filter((tx: any) => {
                    // Skip failed transactions (exit_code != 0)
                    const exitCode = tx.description?.compute_ph?.exit_code ?? tx.description?.action?.result_code ?? 0;
                    if (exitCode !== 0) return false;
                    // Skip bounced transactions (out_total ≈ in_value)
                    const inValue = Number(tx.in_msg?.value || 0);
                    const outTotal = (tx.out_msgs || []).reduce((s: number, m: any) => s + Number(m.value || 0), 0);
                    if (inValue > 100_000_000 && outTotal > inValue * 0.9) return false;
                    return true;
                })
                .map((tx: any) => {
                let opcode: number | null = null;
                let approved: boolean | undefined;
                try {
                    const body = tx.in_msg?.msg_data?.body;
                    if (body) {
                        const cell = Cell.fromBoc(Buffer.from(body, 'base64'))[0];
                        const slice = cell.beginParse();
                        if (slice.remainingBits >= 32) {
                            opcode = slice.loadUint(32);
                            if (opcode === OP.EVALUATE && slice.remainingBits >= 8) {
                                approved = slice.loadUint(8) === 1;
                            }
                        }
                    }
                } catch {}
                return {
                    hash: tx.transaction_id?.hash ? Buffer.from(tx.transaction_id.hash, 'base64').toString('hex') : '',
                    fee: (Number(tx.fee || 0) / 1e9).toFixed(4),
                    utime: tx.utime || 0,
                    opcode,
                    from: tx.in_msg?.source || null,
                    approved,
                };
            });
        } catch {
            if (attempt < 2) await sleep(1000 * (attempt + 1));
        }
    }
    return [];
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ─── Job Indexing ───

const indexLocks = new Set<string>();

async function indexJob(c: TonClient, factory: string, jobId: number, type: 'ton' | 'usdt', force = false) {
    const lockKey = `${type}#${jobId}`;
    if (indexLocks.has(lockKey)) return; // already indexing this job
    indexLocks.add(lockKey);

    const sb = getSupabase();
    if (!sb) { indexLocks.delete(lockKey); return; }

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
            if (existing && [3, 4, 5].includes(existing.state)) {
                indexLocks.delete(lockKey);
                return; // Terminal state — skip
            }
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
        const reasonHashHex = reason.toString(16).padStart(64, '0');

        // Fetch transactions FIRST (fast, non-blocking)
        const txT0 = Date.now();
        const txs = await fetchTransactions(jobAddr);
        log(`  [RPC] getTransactions +${Date.now()-txT0}ms (${txs.length} txs)`);

        // Check existing content to skip unnecessary IPFS
        const { data: existingContent } = await sb.from('jobs').select('description_text, result_text, reason_text, state, provider, submitted_at').eq('address', jobAddr).single();
        const needDesc = !existingContent?.description_text && descHashHex !== ZERO_HASH;
        const needResult = !existingContent?.result_text && resultHashHex !== ZERO_HASH;
        const needReason = !existingContent?.reason_text && reasonHashHex !== ZERO_HASH && state >= 3;

        const effectiveCreatedAt = createdAt || (txs.length > 0 ? txs[txs.length - 1].utime : 0);
        const clientStr = clientAddr.toString(uf);
        const providerStr = providerAddr?.toString(uf) ?? null;
        const evaluatorStr = evaluatorAddr.toString(uf);

        // STEP 1: Upsert job data + transactions IMMEDIATELY (no IPFS wait)
        const jobData: Record<string, any> = {
            job_id: jobId, factory_type: type, address: jobAddr, factory_address: factory,
            state, state_name: stateName,
            client: clientStr, provider: providerStr,
            evaluator: evaluatorStr, budget: budgetNum, budget_formatted: budgetFormatted,
            desc_hash: descHashHex, result_hash: resultHashHex,
            timeout, created_at: effectiveCreatedAt, eval_timeout: evalTimeout,
            submitted_at: submittedAt, result_type: resultType,
            updated_at: new Date().toISOString(),
        };

        await sb.from('jobs').upsert(jobData, { onConflict: 'address' });
        log(`  [DB] Upserted job +${Date.now()-t0}ms`);

        // Transactions table
        for (const tx of txs) {
            if (!tx.hash) continue;
            await sb.from('transactions').upsert({ job_address: jobAddr, tx_hash: tx.hash, fee: tx.fee, utime: tx.utime }, { onConflict: 'tx_hash' });
        }

        // Activity events — rebuild if state, provider, submit, or tx count changed
        const { count: existingTxCount } = await sb.from('transactions').select('*', { count: 'exact', head: true }).eq('job_address', jobAddr);
        const stateChanged = force || !existingContent || existingContent.state !== state
            || existingContent.provider !== providerStr || existingContent.submitted_at !== submittedAt
            || txs.length !== (existingTxCount ?? 0);
        if (!stateChanged) { log(`  [SKIP] Activity unchanged for ${type}#${jobId}`); return; }

        // Build all events first, then delete+insert in one batch (prevents race condition dupes)
        const newEvents: Array<Record<string, any>> = [];
        const chronTxs = [...txs].reverse(); // oldest first
        for (const tx of chronTxs) {
            if (!tx.opcode) continue;
            let event: string | null = null;
            let evStatus = '';
            let amount: string | null = null;
            let from: string | null = null;
            try { from = tx.from ? Address.parse(tx.from).toString(uf) : null; } catch { from = tx.from; }

            switch (tx.opcode) {
                case OP.INIT_JOB:
                    event = 'Created'; evStatus = 'OPEN'; amount = budgetFormatted; from = clientStr;
                    break;
                case OP.FUND:
                case OP.JETTON_NOTIFY:
                    event = 'Funded'; evStatus = 'FUNDED'; amount = budgetFormatted; from = clientStr;
                    break;
                case OP.SET_JETTON_WALLET:
                case OP.SET_BUDGET:
                    continue;
                case OP.TAKE:
                    event = 'Taken'; evStatus = 'FUNDED';
                    break;
                case OP.SUBMIT:
                    event = 'Submitted'; evStatus = 'SUBMITTED'; amount = budgetFormatted;
                    break;
                case OP.EVALUATE: {
                    const isApproved = tx.approved !== undefined ? tx.approved : (state === 3);
                    if (isApproved) {
                        event = 'Approved'; evStatus = 'COMPLETED'; amount = `${budgetFormatted} → Provider`;
                    } else {
                        event = 'Rejected'; evStatus = 'DISPUTED'; amount = budgetFormatted;
                    }
                    from = evaluatorStr;
                    break;
                }
                case OP.CANCEL:
                    event = 'Cancelled'; evStatus = 'CANCELLED'; amount = `${budgetFormatted} → Client`; from = clientStr;
                    break;
                case OP.CLAIM:
                    event = 'Claimed'; evStatus = 'COMPLETED'; amount = `${budgetFormatted} → Provider`;
                    break;
                case OP.QUIT:
                    event = 'Quit'; evStatus = 'FUNDED';
                    break;
                default:
                    continue;
            }
            if (event) {
                newEvents.push({ job_id: jobId, factory_type: type, job_address: jobAddr, event, status: evStatus, time: tx.utime, amount, from_address: from, tx_hash: tx.hash });
            }
        }
        // Replace activity events atomically
        await sb.from('activity_events').delete().eq('job_address', jobAddr);
        if (newEvents.length > 0) {
            await sb.from('activity_events').insert(newEvents);
        }

        // STEP 3: Resolve IPFS content async (does NOT block job/activity)
        if (needDesc || needResult || needReason) {
            const ipfsT0 = Date.now();
            Promise.all([
                needDesc ? resolveContent(descHashHex) : Promise.resolve(null),
                needResult ? resolveContent(resultHashHex) : Promise.resolve(null),
                needReason ? resolveContent(reasonHashHex) : Promise.resolve(null),
            ]).then(async ([desc, res, reas]) => {
                const update: Record<string, any> = {};
                if (desc?.text) { update.description_text = desc.text; if (desc.ipfsUrl) update.description_ipfs_url = desc.ipfsUrl; if (desc.fileCid) update.description_file_cid = desc.fileCid; if (desc.fileName) update.description_file_name = desc.fileName; }
                if (res?.text) { update.result_text = res.text; if (res.ipfsUrl) update.result_ipfs_url = res.ipfsUrl; if (res.fileCid) update.result_file_cid = res.fileCid; if (res.fileName) update.result_file_name = res.fileName; }
                if (reas?.text) { update.reason_text = reas.text; if (reas.ipfsUrl) update.reason_ipfs_url = reas.ipfsUrl; }
                if (Object.keys(update).length > 0) {
                    await sb.from('jobs').update(update).eq('address', jobAddr);
                }
                log(`  [IPFS] Resolved async +${Date.now()-ipfsT0}ms (desc=${!!desc?.text} res=${!!res?.text} reason=${!!reas?.text})`);
            }).catch(() => {});
        }
    } catch (err: any) {
        log(`  indexJob ${type}#${jobId} err: ${err.message}`);
    } finally {
        indexLocks.delete(lockKey);
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
// Track finalized accounts to skip stale pending/confirmed events
const finalizedRecently = new Set<string>();
setInterval(() => finalizedRecently.clear(), 60_000); // Clear every 60s (Catchain 2.0)

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
            min_finality: 'pending',
        }));
        log(`WS subscribed to ${trackedAddresses.length} addresses (pending→finalized)`);
    });

    ws.on('message', async (raw: Buffer) => {
        try {
            const data = JSON.parse(raw.toString());
            if (data.id) return; // subscription confirmation
            if (data.error) { log(`WS error: ${JSON.stringify(data.error)}`); return; }

            if (data.type === 'transactions' && data.transactions) {
                const finality = data.finality || 'unknown';
                for (const tx of data.transactions) {
                    const account = tx.account;
                    if (!account) continue;
                    const acctLower = account.toLowerCase();

                    // Handle pending/confirmed: write pending_state to Supabase
                    if (finality === 'pending' || finality === 'confirmed') {
                        if (finalizedRecently.has(acctLower)) continue; // Skip stale events
                        try {
                            const friendlyAddr = Address.parse(account).toString();
                            const { data: job } = await sb.from('jobs').select('job_id, factory_type').eq('address', friendlyAddr).single();
                            if (job) {
                                const badge = finality === 'pending' ? 'Processing...' : 'Confirming...';
                                await sb.from('jobs').update({ pending_state: badge }).eq('address', friendlyAddr);
                                log(`[WS] ${finality}: ${job.factory_type}#${job.job_id} → ${badge}`);
                            }
                        } catch {}
                        continue;
                    }

                    // trace_invalidated — clear pending state
                    if (finality === 'trace_invalidated') {
                        try {
                            const friendlyAddr = Address.parse(account).toString();
                            await sb.from('jobs').update({ pending_state: null }).eq('address', friendlyAddr);
                            log(`[WS] trace_invalidated for ${account.slice(0, 16)}`);
                        } catch {}
                        continue;
                    }

                    // finalized — full processing
                    finalizedRecently.add(acctLower);
                    const t0 = Date.now();
                    log(`[WS] Event received (${finality}): account=${account.slice(0, 16)}... t=${t0}`);

                    const rawFactory = Address.parse(FACTORY).toRawString().toLowerCase();
                    const rawJettonFactory = Address.parse(JETTON_FACTORY).toRawString().toLowerCase();

                    if (acctLower === rawFactory || acctLower === rawJettonFactory) {
                        const type = acctLower === rawFactory ? 'ton' : 'usdt';
                        const factory = acctLower === rawFactory ? FACTORY : JETTON_FACTORY;
                        log(`[WS] Factory tx (${type}) — checking new jobs t=${Date.now()} (+${Date.now()-t0}ms)`);
                        try {
                            const { data: state } = await sb.from('indexer_state').select('last_job_count').eq('factory_address', factory).single();
                            const lastCount = state?.last_job_count ?? 0;
                            // Retry — factory needs time to deploy job contract
                            let count = lastCount;
                            for (let r = 0; r < 10; r++) {
                                const countResult = await c.runMethod(Address.parse(factory), 'get_next_job_id');
                                count = countResult.stack.readNumber();
                                if (count > lastCount) break;
                                log(`[WS] Count unchanged (${count}), retry ${r+1}/10 in 1s... (+${Date.now()-t0}ms)`);
                                await sleep(1000);
                            }
                            if (count > lastCount) {
                                for (let i = lastCount; i < count; i++) {
                                    log(`[IDX] indexJob start ${type}#${i} t=${Date.now()} (+${Date.now()-t0}ms)`);
                                    await indexJob(c, factory, i, type);
                                    log(`[IDX] indexJob done ${type}#${i} t=${Date.now()} (+${Date.now()-t0}ms)`);
                                }
                                await sb.from('indexer_state').upsert({ factory_address: factory, last_job_count: count, updated_at: new Date().toISOString() }, { onConflict: 'factory_address' });
                                await refreshTrackedAddresses();
                                ws.send(JSON.stringify({ operation: 'subscribe', id: 'enact-idx-update', addresses: trackedAddresses, types: ['transactions'], min_finality: 'pending' }));
                                log(`[WS] Resubscribed ${trackedAddresses.length} addrs t=${Date.now()} (+${Date.now()-t0}ms)`);
                            }
                        } catch (err: any) { log(`[WS] Factory err: ${err.message}`); }
                    } else {
                        // Job transaction — update state + insert activity event
                        let friendlyAddr: string;
                        try { friendlyAddr = Address.parse(account).toString(); } catch { continue; }
                        const { data: job } = await sb.from('jobs').select('job_id, factory_address, factory_type').eq('address', friendlyAddr).single();
                        if (job) {
                            log(`[WS] Processing ${job.factory_type}#${job.job_id} (+${Date.now()-t0}ms)`);
                            try {
                                // 1. Read current state from on-chain
                                const result = await c.runMethod(Address.parse(friendlyAddr), 'get_job_data');
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

                                const uf = { bounceable: false };
                                const stateName = STATE_NAMES[state] ?? 'UNKNOWN';
                                const budgetNum = Number(budget);
                                const budgetFormatted = job.factory_type === 'usdt' ? `${(budgetNum / 1e6).toFixed(2)} USDT` : `${(budgetNum / 1e9).toFixed(2)} TON`;
                                const clientStr = clientAddr.toString(uf);
                                const providerStr = providerAddr?.toString(uf) ?? null;
                                const evaluatorStr = evaluatorAddr.toString(uf);

                                // 2. Update job state in Supabase
                                await sb.from('jobs').update({
                                    state, state_name: stateName,
                                    provider: providerStr,
                                    result_hash: resultHash.toString(16).padStart(64, '0'),
                                    submitted_at: submittedAt,
                                    result_type: resultType,
                                    pending_state: null,
                                    updated_at: new Date().toISOString(),
                                }).eq('address', friendlyAddr);

                                // 3. Parse WS tx to build activity event and INSERT (no DELETE)
                                let opcode: number | null = null;
                                let approved: boolean | undefined;
                                try {
                                    // WS Streaming API v2: in_msg.body is hex (or base64)
                                    const bodyHex = tx.in_msg?.body || tx.in_msg?.msg_data?.body;
                                    if (bodyHex) {
                                        // Try hex first, then base64
                                        let buf: Buffer;
                                        try { buf = Buffer.from(bodyHex, 'hex'); if (buf.length < 4) throw 0; } catch { buf = Buffer.from(bodyHex, 'base64'); }
                                        const cell = Cell.fromBoc(buf)[0];
                                        const slice = cell.beginParse();
                                        if (slice.remainingBits >= 32) {
                                            opcode = slice.loadUint(32);
                                            if (opcode === OP.EVALUATE && slice.remainingBits >= 8) {
                                                approved = slice.loadUint(8) === 1;
                                            }
                                        }
                                    }
                                } catch {}

                                // Determine event from opcode or from state change
                                let event: string | null = null;
                                let evStatus = stateName;
                                let amount: string | null = null;
                                let fromAddr: string | null = null;
                                const txHash = tx.hash || '';
                                const txTime = tx.now || Math.floor(Date.now() / 1000);

                                if (opcode) {
                                    switch (opcode) {
                                        case OP.INIT_JOB: event = 'Created'; evStatus = 'OPEN'; amount = budgetFormatted; fromAddr = clientStr; break;
                                        case OP.FUND: case OP.JETTON_NOTIFY: event = 'Funded'; evStatus = 'FUNDED'; amount = budgetFormatted; fromAddr = clientStr; break;
                                        case OP.TAKE: event = 'Taken'; evStatus = 'FUNDED'; fromAddr = providerStr; break;
                                        case OP.SUBMIT: event = 'Submitted'; evStatus = 'SUBMITTED'; amount = budgetFormatted; fromAddr = providerStr; break;
                                        case OP.EVALUATE: {
                                            const isApproved = approved !== undefined ? approved : (state === 3);
                                            event = isApproved ? 'Approved' : 'Rejected';
                                            evStatus = isApproved ? 'COMPLETED' : 'DISPUTED';
                                            amount = `${budgetFormatted} → Provider`;
                                            fromAddr = evaluatorStr;
                                            break;
                                        }
                                        case OP.CANCEL: event = 'Cancelled'; evStatus = 'CANCELLED'; amount = `${budgetFormatted} → Client`; fromAddr = clientStr; break;
                                        case OP.CLAIM: event = 'Claimed'; evStatus = 'COMPLETED'; amount = `${budgetFormatted} → Provider`; fromAddr = providerStr; break;
                                        case OP.QUIT: event = 'Quit'; evStatus = 'FUNDED'; fromAddr = providerStr; break;
                                    }
                                } else {
                                    // No opcode parsed — derive from state
                                    const stateEvents: Record<number, string> = { 0: 'Created', 1: 'Funded', 2: 'Submitted', 3: 'Completed', 4: 'Disputed', 5: 'Cancelled' };
                                    event = stateEvents[state] ?? null;
                                }

                                if (event && txHash) {
                                    await sb.from('activity_events').upsert({
                                        job_id: job.job_id, factory_type: job.factory_type, job_address: friendlyAddr,
                                        event, status: evStatus, time: txTime, amount, from_address: fromAddr, tx_hash: txHash,
                                    }, { onConflict: 'tx_hash' });
                                    log(`[WS] Activity: ${event} ${job.factory_type}#${job.job_id} → ${stateName} (+${Date.now()-t0}ms)`);
                                } else {
                                    log(`[WS] State updated: ${job.factory_type}#${job.job_id} → ${stateName} (no activity event) (+${Date.now()-t0}ms)`);
                                }

                                // 4. Resolve IPFS content async for new hashes
                                const resultHashHex = resultHash.toString(16).padStart(64, '0');
                                const reasonHashHex = reason.toString(16).padStart(64, '0');
                                if (resultHashHex !== ZERO_HASH || reasonHashHex !== ZERO_HASH) {
                                    const { data: existing } = await sb.from('jobs').select('result_text, reason_text').eq('address', friendlyAddr).single();
                                    if (!existing?.result_text && resultHashHex !== ZERO_HASH) {
                                        resolveContent(resultHashHex).then(async (res) => {
                                            if (res?.text) await sb.from('jobs').update({ result_text: res.text, result_ipfs_url: res.ipfsUrl, result_file_cid: res.fileCid, result_file_name: res.fileName }).eq('address', friendlyAddr);
                                        }).catch(() => {});
                                    }
                                    if (!existing?.reason_text && reasonHashHex !== ZERO_HASH) {
                                        resolveContent(reasonHashHex).then(async (reas) => {
                                            if (reas?.text) await sb.from('jobs').update({ reason_text: reas.text, reason_ipfs_url: reas.ipfsUrl }).eq('address', friendlyAddr);
                                        }).catch(() => {});
                                    }
                                }
                            } catch (err: any) {
                                log(`[WS] err: ${err.message}, falling back to full indexJob`);
                                await indexJob(c, job.factory_address, job.job_id, job.factory_type as 'ton' | 'usdt');
                            }
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
        await sleep(120_000); // 2 min — WS is primary, poller catches anything missed
        try {
            for (const { factory, type } of [
                { factory: FACTORY, type: 'ton' as const },
                { factory: JETTON_FACTORY, type: 'usdt' as const },
            ]) {
                // New jobs check (lightweight — 1 RPC + 1 DB read)
                const countResult = await c.runMethod(Address.parse(factory), 'get_next_job_id');
                const count = countResult.stack.readNumber();
                const { data: state } = await sb.from('indexer_state').select('last_job_count').eq('factory_address', factory).single();
                const lastCount = state?.last_job_count ?? 0;
                if (count > lastCount) {
                    log(`Poll: ${type.toUpperCase()} ${count - lastCount} new job(s)`);
                    for (let i = lastCount; i < count; i++) await indexJob(c, factory, i, type);
                    await sb.from('indexer_state').upsert({ factory_address: factory, last_job_count: count, updated_at: new Date().toISOString() }, { onConflict: 'factory_address' });
                    // Refresh WS subscriptions for new job addresses
                    await refreshTrackedAddresses();
                }

                // Active jobs re-index
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
