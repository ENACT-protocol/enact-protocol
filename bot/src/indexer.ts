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
    const sub = process.env.LIGHTHOUSE_GATEWAY_SUBDOMAIN;
    const urls: string[] = [];
    if (sub) urls.push(`https://${sub}.lighthouseweb3.xyz/ipfs/${cid}`);
    urls.push(
        `https://w3s.link/ipfs/${cid}`,
        `https://nftstorage.link/ipfs/${cid}`,
        `https://dweb.link/ipfs/${cid}`,
        `${IPFS_GW}/${cid}`,
    );
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
        const fetches = urls.map(async (u) => {
            const r = await fetch(u, { signal: ctrl.signal });
            if (!r.ok) throw new Error(`${u}: ${r.status}`);
            return await r.json();
        });
        return await Promise.any(fetches);
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
        ctrl.abort();
    }
}

interface ResolvedContent {
    text: string | null;
    ipfsUrl: string | null;
    fileCid: string | null;
    fileName: string | null;
    encrypted?: boolean;
}

async function tryLighthouse(hash: string): Promise<ResolvedContent | null> {
    if (!process.env.LIGHTHOUSE_API_KEY) return null;
    try {
        const lhRes = await fetch('https://api.lighthouse.storage/api/user/files_uploaded?lastKey=null', {
            headers: { Authorization: `Bearer ${process.env.LIGHTHOUSE_API_KEY}` },
            signal: AbortSignal.timeout(8000),
        });
        if (!lhRes.ok) return null;
        const data = await lhRes.json() as { fileList?: Array<{ cid: string; fileName: string }> };
        if (!data.fileList?.length) return null;
        const tag = hash.slice(0, 8);
        const match = data.fileList.find(f => f.fileName?.startsWith(`enact-${tag}`) || f.fileName?.startsWith(`enact-file-${tag}`));
        if (!match) return null;
        const ipfsUrl = `${IPFS_GW}/${match.cid}`;
        if (!match.fileName.endsWith('.json')) return { text: null, ipfsUrl, fileCid: match.cid, fileName: match.fileName };
        const d = await fetchFromIPFS(match.cid);
        if (d) {
            if (d.type === 'job_result_encrypted') return { text: null, ipfsUrl, fileCid: null, fileName: null, encrypted: true };
            return { text: d.description ?? d.result ?? d.reason ?? null, ipfsUrl, fileCid: d.file?.cid || null, fileName: d.file?.filename || null };
        }
        return { text: null, ipfsUrl, fileCid: null, fileName: null };
    } catch {
        return null;
    }
}

async function resolveContent(hash: string): Promise<ResolvedContent> {
    if (!hash || hash === ZERO_HASH) return { text: null, ipfsUrl: null, fileCid: null, fileName: null };
    try {
        const clean = hash.replace(/0+$/, '');
        if (clean.length >= 4) {
            const bytes = Buffer.from(clean, 'hex').toString('utf-8').replace(/\0/g, '');
            if (/^[\x20-\x7E\n\r\t]+$/.test(bytes) && bytes.length > 2) return { text: bytes, ipfsUrl: null, fileCid: null, fileName: null };
        }
    } catch {}
    // Lighthouse first (primary provider in the SDK)
    const lh = await tryLighthouse(hash);
    if (lh) return lh;
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
                        // Detect encrypted results (type: 'job_result_encrypted')
                        if (data.type === 'job_result_encrypted') {
                            return { text: null, ipfsUrl: `${IPFS_GW}/${pin.ipfs_pin_hash}`, fileCid: null, fileName: null, encrypted: true };
                        }
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

// ─── Transaction Parsing (v3 schema — used by both WS events and REST fallback) ───

function parseV3Tx(tx: any): ParsedTx | null {
    // Skip failed/aborted transactions
    if (tx.description?.aborted === true) return null;
    const exitCode = tx.description?.compute_ph?.exit_code ?? 0;
    if (exitCode !== 0) return null;

    let opcode: number | null = null;
    let approved: boolean | undefined;
    try {
        const opcodeHex = tx.in_msg?.opcode;
        if (opcodeHex) opcode = parseInt(opcodeHex, 16);
        // For EVALUATE, parse body to get approved flag
        if (opcode === OP.EVALUATE) {
            const bodyB64 = tx.in_msg?.message_content?.body;
            if (bodyB64) {
                const cell = Cell.fromBoc(Buffer.from(bodyB64, 'base64'))[0];
                const slice = cell.beginParse();
                if (slice.remainingBits >= 40) {
                    slice.loadUint(32);
                    approved = slice.loadUint(8) === 1;
                }
            }
        }
    } catch {}
    // v3 hash is base64 — convert to hex for consistency
    const hashHex = tx.hash ? Buffer.from(tx.hash, 'base64').toString('hex') : '';
    let from: string | null = null;
    try { from = tx.in_msg?.source ? Address.parse(tx.in_msg.source).toString({ bounceable: false }) : null; } catch { from = tx.in_msg?.source || null; }
    const utime = tx.now || 0;
    return { hash: hashHex, fee: (Number(tx.total_fees || 0) / 1e9).toFixed(4), utime, opcode, from, approved };
}

/** Parse transactions directly from WS event data (v3 Transaction schema) */
function parseWsTxs(wsTxs: any[]): ParsedTx[] {
    const results: ParsedTx[] = [];
    for (const tx of wsTxs) {
        const parsed = parseV3Tx(tx);
        if (parsed) results.push(parsed);
    }
    return results;
}

/** Fetch transactions via REST v3 (polling fallback only) */
async function fetchTransactions(address: string): Promise<ParsedTx[]> {
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const url = `https://toncenter.com/api/v3/transactions?account=${encodeURIComponent(address)}&limit=20&sort=desc`;
            const headers: Record<string, string> = {};
            if (API_KEY) headers['X-API-Key'] = API_KEY;
            const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
            if (res.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
            if (!res.ok) return [];
            const data = await res.json() as { transactions?: any[] };
            return (data.transactions ?? []).map(parseV3Tx).filter((t): t is ParsedTx => t !== null);
        } catch (err: any) {
            if (attempt < 2) await sleep(1000 * (attempt + 1));
        }
    }
    return [];
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ─── Job Indexing ───

const indexLocks = new Set<string>();

async function indexJob(c: TonClient, factory: string, jobId: number, type: 'ton' | 'usdt', force = false, wsTxs?: ParsedTx[]) {
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
                // Terminal state — only skip if activity is complete
                const { count } = await sb.from('activity_events').select('*', { count: 'exact', head: true }).eq('job_address', jobAddr);
                const minEvents = existing.state === 5 ? 3 : 5; // CANCELLED=3, COMPLETED/DISPUTED=5
                if ((count ?? 0) >= minEvents) {
                    indexLocks.delete(lockKey);
                    return;
                }
                // Terminal but missing activity — fall through to rebuild
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

        // Use WS-provided txs if available (instant), otherwise fetch via REST (polling fallback)
        const txT0 = Date.now();
        let txs: ParsedTx[];
        if (wsTxs && wsTxs.length > 0) {
            txs = wsTxs;
            log(`  [WS-TX] ${txs.length} txs from event +${Date.now()-txT0}ms`);
        } else {
            txs = await fetchTransactions(jobAddr);
            log(`  [REST] getTransactions +${Date.now()-txT0}ms (${txs.length} txs)`);
        }

        // Check existing content to skip unnecessary IPFS
        const { data: existingContent } = await sb.from('jobs').select('description_text, result_text, result_encrypted, reason_text, state, provider, submitted_at').eq('address', jobAddr).single();
        const needDesc = !existingContent?.description_text && descHashHex !== ZERO_HASH;
        const needResult = !existingContent?.result_text && !existingContent?.result_encrypted && resultHashHex !== ZERO_HASH;
        const needReason = !existingContent?.reason_text && reasonHashHex !== ZERO_HASH && state >= 3;

        const effectiveCreatedAt = createdAt || (txs.length > 0 ? txs[txs.length - 1].utime : 0);
        const clientStr = clientAddr.toString(uf);
        const providerStr = providerAddr?.toString(uf) ?? null;
        const evaluatorStr = evaluatorAddr.toString(uf);

        // STEP 1: Upsert job data + transactions IMMEDIATELY (no IPFS wait)
        // Always clear pending_state on force (WS finalized) to remove stale badges
        const jobData: Record<string, any> = {
            job_id: jobId, factory_type: type, address: jobAddr, factory_address: factory,
            state, state_name: stateName,
            client: clientStr, provider: providerStr,
            evaluator: evaluatorStr, budget: budgetNum, budget_formatted: budgetFormatted,
            desc_hash: descHashHex, result_hash: resultHashHex, reason_hash: reasonHashHex,
            timeout, created_at: effectiveCreatedAt, eval_timeout: evalTimeout,
            submitted_at: submittedAt, result_type: resultType,
            updated_at: new Date().toISOString(),
        };

        // On force (WS finalized), clear pending_state immediately
        if (force) {
            jobData.pending_state = null;
        }

        // Skip upsert if nothing changed (prevents noisy RT updates from poller)
        if (!force && existingContent &&
            existingContent.state === state &&
            existingContent.provider === providerStr &&
            existingContent.submitted_at === submittedAt) {
            // State unchanged — skip job upsert, still check activity below
            log(`  [SKIP] Job unchanged for ${type}#${jobId} +${Date.now()-t0}ms`);
        } else {
            await sb.from('jobs').upsert(jobData, { onConflict: 'address' });
            log(`  [DB] Upserted job +${Date.now()-t0}ms`);
        }

        // Transactions table
        for (const tx of txs) {
            if (!tx.hash) continue;
            await sb.from('transactions').upsert({ job_address: jobAddr, tx_hash: tx.hash, fee: tx.fee, utime: tx.utime }, { onConflict: 'tx_hash' });
        }

        // Activity events — build and compare with existing count

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
        // Activity events: only INSERT new events (never DELETE — prevents flicker)
        const { data: existingEvents } = await sb.from('activity_events').select('tx_hash').eq('job_address', jobAddr);
        const existingHashes = new Set((existingEvents ?? []).map((e: any) => e.tx_hash));
        const toInsert = newEvents.filter(e => e.tx_hash && !existingHashes.has(e.tx_hash));
        if (toInsert.length > 0) {
            log(`  [ACTIVITY] ${type}#${jobId}: +${toInsert.length} new events (total ${existingHashes.size + toInsert.length}) (opcodes: ${txs.map(t=>t.opcode).join(',')})`);
            const { error: insErr } = await sb.from('activity_events').insert(toInsert);
            if (insErr) log(`  [ACTIVITY] INSERT error: ${insErr.message}`);
        } else if (newEvents.length > 0) {
            log(`  [SKIP] Activity unchanged for ${type}#${jobId}`);
        } else if (force && existingHashes.size === 0 && state === 0) {
            // New job with no txs yet (v3 not indexed) — insert synthetic "Created" event
            const syntheticEvent = { job_id: jobId, factory_type: type, job_address: jobAddr, event: 'Created', status: 'OPEN', time: effectiveCreatedAt || Math.floor(Date.now() / 1000), amount: budgetFormatted, from_address: clientStr, tx_hash: `synthetic_init_${jobAddr.slice(0,20)}` };
            const { error: synErr } = await sb.from('activity_events').insert(syntheticEvent);
            if (synErr) log(`  [ACTIVITY] synthetic insert error: ${synErr.message}`);
            else log(`  [ACTIVITY] ${type}#${jobId}: synthetic Created event inserted`);
        } else {
            log(`  [ACTIVITY] ${type}#${jobId}: 0 events from ${txs.length} txs`);
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
                if (res) {
                    if (res.encrypted) {
                        // Mark result as encrypted so frontend shows proper badge instead of "Loading from IPFS..."
                        update.result_encrypted = true;
                        if (res.ipfsUrl) update.result_ipfs_url = res.ipfsUrl;
                    } else if (res.text) {
                        update.result_text = res.text;
                        if (res.ipfsUrl) update.result_ipfs_url = res.ipfsUrl;
                        if (res.fileCid) update.result_file_cid = res.fileCid;
                        if (res.fileName) update.result_file_name = res.fileName;
                    }
                }
                if (reas?.text) { update.reason_text = reas.text; if (reas.ipfsUrl) update.reason_ipfs_url = reas.ipfsUrl; }
                if (Object.keys(update).length > 0) {
                    await sb.from('jobs').update(update).eq('address', jobAddr);
                }
                log(`  [IPFS] Resolved async +${Date.now()-ipfsT0}ms (desc=${!!desc?.text} res=${res?.encrypted ? 'encrypted' : !!res?.text} reason=${!!reas?.text})`);
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
                    // Terminal + has content — but check activity completeness
                    const { count: actCount } = await sb.from('activity_events').select('*', { count: 'exact', head: true }).eq('job_address', jobAddr);
                    const minEvents = existing.state === 5 ? 3 : 5; // CANCELLED=3, COMPLETED/DISPUTED=5
                    if ((actCount ?? 0) >= minEvents) continue; // Fully indexed
                    log(`Backfill: rebuilding ${type}#${i} (${actCount} events, need ${minEvents})`);
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
let activeWs: WebSocket | null = null;
// Track finalized accounts (used by factory handler to avoid duplicate indexing)
const finalizedRecently = new Set<string>();
setInterval(() => finalizedRecently.clear(), 300_000);

async function refreshTrackedAddresses() {
    const sb = getSupabase();
    if (!sb) return;

    // Factories + all active job addresses
    const addrs = new Set<string>();
    addrs.add(Address.parse(FACTORY).toRawString());
    addrs.add(Address.parse(JETTON_FACTORY).toRawString());

    // Track ALL non-terminal jobs (OPEN, FUNDED, SUBMITTED) — these can still change
    const { data: jobs } = await sb.from('jobs').select('address').in('state_name', ['OPEN', 'FUNDED', 'SUBMITTED']);
    if (jobs) {
        for (const j of jobs) {
            try { addrs.add(Address.parse(j.address).toRawString()); } catch {}
        }
    }

    trackedAddresses = [...addrs];
}

/** Resubscribe the active WS to current tracked addresses */
function resubscribeWs() {
    if (!activeWs || activeWs.readyState !== WebSocket.OPEN) return;
    activeWs.send(JSON.stringify({
        operation: 'subscribe', id: 'enact-idx',
        addresses: trackedAddresses,
        types: ['transactions'],
        min_finality: 'finalized',
    }));
    log(`[WS] Resubscribed to ${trackedAddresses.length} addresses`);
}

function connectWebSocket() {
    const sb = getSupabase();
    const c = getClient();
    if (!sb) return;

    const ws = new WebSocket(WS_URL);
    activeWs = ws;
    let pingInterval: NodeJS.Timeout | null = null;

    ws.on('open', async () => {
        log(`WS connected`);
        wsReconnectDelay = 1000; // Reset backoff
        pingInterval = setInterval(() => ws.ping(), 15000);

        await refreshTrackedAddresses();
        resubscribeWs();
    });

    ws.on('message', async (raw: Buffer) => {
        try {
            const data = JSON.parse(raw.toString());
            if (data.id) return; // subscription confirmation
            if (data.error) { log(`WS error: ${JSON.stringify(data.error)}`); return; }

            if (data.type === 'transactions' && data.transactions) {
                const finality = data.finality || 'unknown';

                // Parse ALL transaction data from WS event (v3 schema — no REST needed!)
                const allWsTxs = parseWsTxs(data.transactions);

                // Group raw WS txs by account for per-job processing
                const txsByAccount = new Map<string, any[]>();
                for (const rawTx of data.transactions) {
                    if (!rawTx.account) continue;
                    const key = rawTx.account.toLowerCase();
                    if (!txsByAccount.has(key)) txsByAccount.set(key, []);
                    txsByAccount.get(key)!.push(rawTx);
                }

                // Collect unique accounts
                const accounts = new Set<string>();
                for (const tx of data.transactions) {
                    if (tx.account) accounts.add(tx.account);
                }

                for (const account of accounts) {
                    const acctLower = account.toLowerCase();

                    // Skip pending/confirmed — no DB writes needed, finalized handles everything
                    // (pending/confirmed writes caused RT noise + state revert bugs)
                    if (finality === 'pending' || finality === 'confirmed' || finality === 'trace_invalidated') continue;

                    // finalized — process in background (non-blocking, parallel)
                    finalizedRecently.add(acctLower);
                    const accountTxs = parseWsTxs(txsByAccount.get(acctLower) || []);

                    // Fire-and-forget — each account processed independently
                    (async () => {
                        const t0 = Date.now();
                        log(`[WS] Finalized: account=${account.slice(0, 16)}... t=${t0}`);

                        const rawFactory = Address.parse(FACTORY).toRawString().toLowerCase();
                        const rawJettonFactory = Address.parse(JETTON_FACTORY).toRawString().toLowerCase();

                        if (acctLower === rawFactory || acctLower === rawJettonFactory) {
                            // Factory tx — new job created
                            const type = acctLower === rawFactory ? 'ton' : 'usdt';
                            const factory = acctLower === rawFactory ? FACTORY : JETTON_FACTORY;
                            log(`[WS] Factory tx (${type}) — checking new jobs (+${Date.now()-t0}ms)`);
                            try {
                                const { data: state } = await sb.from('indexer_state').select('last_job_count').eq('factory_address', factory).single();
                                const lastCount = state?.last_job_count ?? 0;
                                let count = lastCount;
                                for (let r = 0; r < 5; r++) {
                                    const countResult = await c.runMethod(Address.parse(factory), 'get_next_job_id');
                                    count = countResult.stack.readNumber();
                                    if (count > lastCount) break;
                                    log(`[WS] Count unchanged (${count}), retry ${r+1}/5 in 200ms... (+${Date.now()-t0}ms)`);
                                    await sleep(200);
                                }
                                if (count > lastCount) {
                                    for (let i = lastCount; i < count; i++) {
                                        // Try to find new job's txs in the WS event (trace contains INIT_JOB tx)
                                        let jobWsTxs: ParsedTx[] | undefined;
                                        try {
                                            const addrResult = await c.runMethod(Address.parse(factory), 'get_job_address', [{ type: 'int', value: BigInt(i) }]);
                                            const jobRaw = addrResult.stack.readAddress().toRawString().toLowerCase();
                                            const rawTxs = txsByAccount.get(jobRaw);
                                            if (rawTxs) {
                                                jobWsTxs = parseWsTxs(rawTxs);
                                                log(`[WS] Found ${jobWsTxs.length} WS txs for new job ${type}#${i} in trace (+${Date.now()-t0}ms)`);
                                            }
                                        } catch {}
                                        log(`[IDX] indexJob start ${type}#${i} (+${Date.now()-t0}ms)`);
                                        await indexJob(c, factory, i, type, true, jobWsTxs);
                                        log(`[IDX] indexJob done ${type}#${i} (+${Date.now()-t0}ms)`);
                                    }
                                    await sb.from('indexer_state').upsert({ factory_address: factory, last_job_count: count, updated_at: new Date().toISOString() }, { onConflict: 'factory_address' });
                                    await refreshTrackedAddresses();
                                    resubscribeWs();
                                }
                            } catch (err: any) { log(`[WS] Factory err: ${err.message}`); }
                        } else {
                            // Job transaction — use WS tx data directly (no REST, no sleep!)
                            let friendlyAddr: string;
                            try { friendlyAddr = Address.parse(account).toString(); } catch { return; }

                            // No separate pending_state clear — indexJob upsert handles it (force=true sets pending_state=null)
                            const { data: job } = await sb.from('jobs').select('job_id, factory_address, factory_type, state').eq('address', friendlyAddr).single();
                            if (job) {
                                log(`[WS] Indexing ${job.factory_type}#${job.job_id} with ${accountTxs.length} WS txs (+${Date.now()-t0}ms)`);
                                await indexJob(c, job.factory_address, job.job_id, job.factory_type as 'ton' | 'usdt', true, accountTxs);
                                log(`[WS] Done ${job.factory_type}#${job.job_id} (+${Date.now()-t0}ms)`);
                            } else {
                                // Job not in DB — discovery
                                log(`[WS] Unknown job ${friendlyAddr.slice(0, 16)} — trying discovery`);
                                for (const { factory, ftype } of [
                                    { factory: FACTORY, ftype: 'ton' as const },
                                    { factory: JETTON_FACTORY, ftype: 'usdt' as const },
                                ]) {
                                    try {
                                        const countResult = await c.runMethod(Address.parse(factory), 'get_next_job_id');
                                        const count = countResult.stack.readNumber();
                                        const { data: stateRow } = await sb.from('indexer_state').select('last_job_count').eq('factory_address', factory).single();
                                        const lastCount = stateRow?.last_job_count ?? 0;
                                        if (count > lastCount) {
                                            log(`[WS] Discovery: ${ftype} has ${count - lastCount} new job(s)`);
                                            for (let i = lastCount; i < count; i++) {
                                                await indexJob(c, factory, i, ftype, true);
                                            }
                                            await sb.from('indexer_state').upsert({ factory_address: factory, last_job_count: count, updated_at: new Date().toISOString() }, { onConflict: 'factory_address' });
                                            await refreshTrackedAddresses();
                                            resubscribeWs();
                                        }
                                    } catch {}
                                }
                            }
                        }
                    })().catch(err => log(`[WS] Async finalized err: ${err.message}`));
                }
            }
        } catch (err: any) {
            log(`WS message err: ${err.message}`);
        }
    });

    ws.on('error', (err: Error) => log(`WS error: ${err.message}`));

    ws.on('close', (code: number) => {
        if (pingInterval) clearInterval(pingInterval);
        activeWs = null;
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
                    for (let i = lastCount; i < count; i++) await indexJob(c, factory, i, type, true);
                    await sb.from('indexer_state').upsert({ factory_address: factory, last_job_count: count, updated_at: new Date().toISOString() }, { onConflict: 'factory_address' });
                    // Refresh WS subscriptions for new job addresses
                    await refreshTrackedAddresses();
                    resubscribeWs();
                }

                // NO active jobs re-index — WS handles all state changes in real-time.
                // Poller only catches new jobs and rebuilds incomplete terminal jobs.

                // Terminal jobs missing activity — rebuild once
                const { data: incompleteJobs } = await sb.from('jobs').select('job_id, address, factory_address, factory_type, state_name').eq('factory_address', factory).in('state_name', ['COMPLETED', 'DISPUTED', 'CANCELLED']);
                if (incompleteJobs) {
                    for (const ij of incompleteJobs) {
                        const { count } = await sb.from('activity_events').select('*', { count: 'exact', head: true }).eq('job_address', ij.address);
                        const minEv = ij.state_name === 'CANCELLED' ? 3 : 5;
                        if ((count ?? 0) < minEv) {
                            log(`Poll: rebuilding activity for terminal ${ij.factory_type}#${ij.job_id} (${count}/${minEv} events)`);
                            await indexJob(c, ij.factory_address, ij.job_id, ij.factory_type as 'ton' | 'usdt', true);
                        }
                    }
                }

                // Clean up stale pending_state — any pending_state older than 2 minutes is stale
                const twoMinAgo = new Date(Date.now() - 120_000).toISOString();
                const { data: staleJobs } = await sb.from('jobs')
                    .select('address, pending_state, updated_at')
                    .not('pending_state', 'is', null)
                    .lt('updated_at', twoMinAgo);
                if (staleJobs && staleJobs.length > 0) {
                    log(`Poll: clearing ${staleJobs.length} stale pending_state badges`);
                    for (const sj of staleJobs) {
                        await sb.from('jobs').update({ pending_state: null }).eq('address', sj.address);
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
