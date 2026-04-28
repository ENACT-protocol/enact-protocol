import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { EnactClient } from '@enact-protocol/sdk';

const FACTORY = 'EQAFHodWCzrYJTbrbJp1lMDQLfypTHoJCd0UcerjsdxPECjX';
const JETTON_FACTORY = 'EQCgYmwi8uwrG7I6bI3Cdv0ct-bAB1jZ0DQ7C3dX3MYn6VTj';
const API_KEY = process.env.TONCENTER_API_KEY || '';
// Public gateway for non-authenticated viewers (file links shown in UI).
// gateway.lighthouse.storage is paywalled (402), ipfs.io is unreliable for fresh
// Lighthouse pins. Keep ipfs.io as the human-facing default (works once the CID
// propagates to public gateways) and use a race-fetch helper for our own reads.
// Public-facing gateway for content stored on Pinata (DHT-friendly, served
// reliably by the public ipfs.io). Lighthouse-only pins go through the
// per-account subdomain because Lighthouse doesn't always announce CIDs
// to the public DHT promptly.
const PINATA_GW = 'https://ipfs.io/ipfs';
const LH_GW = process.env.LIGHTHOUSE_GATEWAY_SUBDOMAIN
  ? `https://${process.env.LIGHTHOUSE_GATEWAY_SUBDOMAIN}.lighthouseweb3.xyz/ipfs`
  : 'https://ipfs.io/ipfs';
const ZERO_HASH = '0'.repeat(64);

// Race a CID across multiple IPFS gateways. The first 2xx response wins.
// Lighthouse per-account subdomain is fastest because the account already
// holds the pin; public gateways serve as backup once the CID propagates.
async function fetchIpfsJson(cid: string, timeoutMs = 6000): Promise<Record<string, any> | null> {
  const sub = process.env.LIGHTHOUSE_GATEWAY_SUBDOMAIN; // e.g. "numerous-gorilla-z5as6"
  const urls: string[] = [];
  if (sub) urls.push(`https://${sub}.lighthouseweb3.xyz/ipfs/${cid}`);
  urls.push(
    `https://w3s.link/ipfs/${cid}`,
    `https://nftstorage.link/ipfs/${cid}`,
    `https://dweb.link/ipfs/${cid}`,
    `https://ipfs.io/ipfs/${cid}`,
  );
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const fetches = urls.map(async (u): Promise<Record<string, any>> => {
      const r = await fetch(u, { signal: ctrl.signal });
      if (!r.ok) throw new Error(`${u}: ${r.status}`);
      return await r.json() as Record<string, any>;
    });
    const json = await Promise.any(fetches);
    return json;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}

const BUILD_VERSION = 'v2'; // Bump to invalidate terminalCache on redeploy

// ─── Supabase Read ───

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

// Per-request Lighthouse list cache: avoids hammering the API once per job
// when the Supabase row exists but `description_text` is null (e.g. legacy
// indexer wrote null before the Lighthouse fix).
let _lhListCache: { ts: number; list: Array<{ cid: string; fileName: string }> } | null = null;
async function getLighthouseList(): Promise<Array<{ cid: string; fileName: string }>> {
  if (!process.env.LIGHTHOUSE_API_KEY) return [];
  const now = Date.now();
  if (_lhListCache && now - _lhListCache.ts < 30_000) return _lhListCache.list;
  try {
    const res = await fetch('https://api.lighthouse.storage/api/user/files_uploaded?lastKey=null', {
      headers: { Authorization: `Bearer ${process.env.LIGHTHOUSE_API_KEY}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const data = await res.json() as { fileList?: Array<{ cid: string; fileName: string }> };
    const list = data.fileList ?? [];
    _lhListCache = { ts: now, list };
    return list;
  } catch {
    return [];
  }
}

// Resolve a hash directly from a precomputed Lighthouse list (no per-call list fetch).
// Used by the Supabase backfill path so 173 jobs share one Lighthouse listing.
async function resolveFromList(hash: string, list: Array<{ cid: string; fileName: string }>): Promise<{ text: string | null; ipfsUrl: string | null }> {
  if (!hash || hash === ZERO_HASH) return { text: null, ipfsUrl: null };
  // Hex-decoded short text
  try {
    const clean = hash.replace(/0+$/, '');
    if (clean.length >= 4) {
      const bytes = Buffer.from(clean, 'hex').toString('utf-8').replace(/\0/g, '');
      if (/^[\x20-\x7E\n\r\t]+$/.test(bytes) && bytes.length > 2) return { text: bytes, ipfsUrl: null };
    }
  } catch {}
  const tag = hash.slice(0, 8);
  // SDK uploads with `enact-<tag>.json`, attached files as `enact-file-<tag>.<ext>`,
  // and the AI evaluator writes rejection reasons as `enact-reason-<tag>.json`.
  const match = list.find(f => f.fileName?.startsWith(`enact-${tag}`) || f.fileName?.startsWith(`enact-file-${tag}`) || f.fileName?.startsWith(`enact-reason-${tag}`));
  if (!match || !match.fileName.endsWith('.json')) return { text: null, ipfsUrl: null };
  const ipfsUrl = `${LH_GW}/${match.cid}`;
  const d = await fetchIpfsJson(match.cid);
  if (!d) return { text: null, ipfsUrl };
  if (d.type === 'job_result_encrypted') return { text: null, ipfsUrl };
  const text = d.description ?? d.result ?? d.reason ?? null;
  return { text, ipfsUrl };
}

// Pick the right public gateway per CID:
//   - Lighthouse pins (in our account list) → per-account lighthouseweb3.xyz
//     subdomain (Lighthouse doesn't always announce CIDs to the public DHT).
//   - Pinata pins → ipfs.io (Pinata announces reliably).
function gatewayForCid(cid: string, lhCids: Set<string>): string {
  return lhCids.has(cid) ? LH_GW : PINATA_GW;
}

function rewriteIpfsUrl(stored: string | null | undefined, lhCids: Set<string>): string | null {
  if (!stored) return null;
  const m = stored.match(/\/ipfs\/([^/?#]+)/);
  if (!m) return stored;
  return `${gatewayForCid(m[1], lhCids)}/${m[1]}`;
}

// After Supabase transform, fill in any text==null for jobs that have a non-zero
// hash. Writes results back to Supabase so subsequent requests skip the work.
async function backfillMissingContent(jobs: any[], sb: any) {
  const list = await getLighthouseList();
  const lhCids = new Set(list.map(f => f.cid));

  await Promise.all(jobs.map(async (j) => {
    const tasks: Promise<void>[] = [];
    const updates: Record<string, any> = {};

    // Rewrite stored URLs so each CID points to the right gateway: Lighthouse
    // CIDs go through the per-account subdomain, Pinata CIDs through ipfs.io.
    for (const key of ['description', 'resultContent', 'reasonContent'] as const) {
      const c: any = j[key];
      if (!c?.ipfsUrl) continue;
      const fresh = rewriteIpfsUrl(c.ipfsUrl, lhCids);
      if (fresh && fresh !== c.ipfsUrl) {
        c.ipfsUrl = fresh;
        const col = key === 'description' ? 'description_ipfs_url' : key === 'resultContent' ? 'result_ipfs_url' : 'reason_ipfs_url';
        updates[col] = fresh;
      }
    }
    if (j.description?.file?.ipfsUrl) {
      const fresh = rewriteIpfsUrl(j.description.file.ipfsUrl, lhCids);
      if (fresh) j.description.file.ipfsUrl = fresh;
    }
    if (j.resultContent?.file?.ipfsUrl) {
      const fresh = rewriteIpfsUrl(j.resultContent.file.ipfsUrl, lhCids);
      if (fresh) j.resultContent.file.ipfsUrl = fresh;
    }

    if (list.length === 0) {
      if (Object.keys(updates).length > 0) {
        await sb.from('jobs').update(updates).eq('address', j.address).then(() => {}, () => {});
      }
      return;
    }

    if (!j.description?.text && j.descHash && j.descHash !== ZERO_HASH && j.description?.source === 'hash') {
      tasks.push(resolveFromList(j.descHash, list).then(r => {
        if (r.text) {
          j.description = { text: r.text, source: 'ipfs', ipfsUrl: r.ipfsUrl, ...(j.description?.file ? { file: j.description.file } : {}) };
          updates.description_text = r.text;
          if (r.ipfsUrl) updates.description_ipfs_url = r.ipfsUrl;
        }
      }));
    }
    if (!j.resultContent?.text && !j.resultContent?.encrypted && j.resultHash && j.resultHash !== ZERO_HASH && j.resultContent?.source === 'hash') {
      tasks.push(resolveFromList(j.resultHash, list).then(r => {
        if (r.text) {
          j.resultContent = { text: r.text, source: 'ipfs', ipfsUrl: r.ipfsUrl, ...(j.resultContent?.file ? { file: j.resultContent.file } : {}) };
          updates.result_text = r.text;
          if (r.ipfsUrl) updates.result_ipfs_url = r.ipfsUrl;
        }
      }));
    }
    if (!j.reasonContent?.text && j.reasonHash && j.reasonHash !== ZERO_HASH && j.reasonContent?.source === 'hash') {
      tasks.push(resolveFromList(j.reasonHash, list).then(r => {
        if (r.text) {
          j.reasonContent = { text: r.text, source: 'ipfs', ipfsUrl: r.ipfsUrl };
          updates.reason_text = r.text;
          if (r.ipfsUrl) updates.reason_ipfs_url = r.ipfsUrl;
        }
      }));
    }

    if (tasks.length === 0) return;
    await Promise.all(tasks);
    if (Object.keys(updates).length > 0) {
      await sb.from('jobs').update(updates).eq('address', j.address).then(() => {}, () => {});
    }
  }));
}

async function fetchFromSupabase() {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase not configured');

  const [{ data: jobs, error: jobsErr }, { data: txs }, { data: activity }] = await Promise.all([
    sb.from('jobs').select('*').order('created_at', { ascending: false }),
    sb.from('transactions').select('*').order('utime', { ascending: false }),
    sb.from('activity_events').select('*').order('time', { ascending: false }),
  ]);

  if (jobsErr || !jobs || jobs.length === 0) throw new Error('No data in Supabase');

  const txByJob = new Map<string, any[]>();
  for (const tx of (txs ?? [])) {
    const arr = txByJob.get(tx.job_address) ?? [];
    arr.push({ hash: tx.tx_hash, fee: tx.fee, utime: tx.utime });
    txByJob.set(tx.job_address, arr);
  }

  const transform = (j: any) => {
    const descContent: any = j.description_text
      ? { text: j.description_text, source: j.description_ipfs_url ? 'ipfs' : 'hex', ipfsUrl: j.description_ipfs_url }
      : { text: null, source: 'hash' };
    if (j.description_file_cid) {
      const ext = (j.description_file_name || '').split('.').pop()?.toLowerCase() || '';
      const imgExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
      descContent.file = { filename: j.description_file_name || 'file', mimeType: imgExts.includes(ext) ? `image/${ext === 'jpg' ? 'jpeg' : ext}` : 'application/octet-stream', size: 0, ipfsUrl: `${PINATA_GW}/${j.description_file_cid}` };
    }

    const resContent: any = j.result_encrypted
      ? { text: null, source: 'ipfs', ipfsUrl: j.result_ipfs_url, encrypted: true }
      : j.result_text
        ? { text: j.result_text, source: j.result_ipfs_url ? 'ipfs' : 'hex', ipfsUrl: j.result_ipfs_url }
        : { text: null, source: 'hash' };
    if (j.result_file_cid) {
      const ext = (j.result_file_name || '').split('.').pop()?.toLowerCase() || '';
      const imgExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
      resContent.file = { filename: j.result_file_name || 'file', mimeType: imgExts.includes(ext) ? `image/${ext === 'jpg' ? 'jpeg' : ext}` : 'application/octet-stream', size: 0, ipfsUrl: `${PINATA_GW}/${j.result_file_cid}` };
    }

    return {
      jobId: j.job_id, address: j.address, type: j.factory_type,
      state: j.state, stateName: j.state_name,
      client: j.client, provider: j.provider, evaluator: j.evaluator,
      budget: String(j.budget), budgetFormatted: j.budget_formatted,
      descHash: j.desc_hash, resultHash: j.result_hash, reasonHash: j.reason_hash || '',
      timeout: j.timeout, createdAt: j.created_at,
      evalTimeout: j.eval_timeout, submittedAt: j.submitted_at,
      resultType: j.result_type,
      description: descContent,
      resultContent: resContent,
      reasonContent: j.reason_text
        ? { text: j.reason_text, source: j.reason_ipfs_url ? 'ipfs' : 'hex', ipfsUrl: j.reason_ipfs_url }
        : { text: null, source: 'hash' },
      hasFile: !!(j.description_file_cid || j.result_file_cid),
      pendingState: j.pending_state || null,
      transactions: txByJob.get(j.address) ?? [],
    };
  };

  const tonJobs = jobs.filter((j: any) => j.factory_type === 'ton').map(transform);
  const jettonJobs = jobs.filter((j: any) => j.factory_type === 'usdt').map(transform);

  // Self-heal: legacy indexer wrote description_text=null for jobs whose
  // CIDs only resolved through a paywalled or unreliable gateway. Refetch
  // missing fields here and write them back to Supabase.
  await backfillMissingContent([...tonJobs, ...jettonJobs], sb);

  const activityEvents = (activity ?? []).map((e: any) => ({
    jobId: e.job_id, type: e.factory_type, address: e.job_address,
    event: e.event, status: e.status, time: e.time,
    amount: e.amount, from: e.from_address, txHash: e.tx_hash,
  }));

  return {
    tonJobs, jettonJobs,
    activity: activityEvents,
    factories: {
      ton: { address: FACTORY, jobCount: tonJobs.length },
      jetton: { address: JETTON_FACTORY, jobCount: jettonJobs.length },
    },
    lastUpdated: Date.now(),
  };
}

// ─── RPC Fallback with transactions ───

async function fetchWithRetry(url: string, retries = 3): Promise<Response | null> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (res.status === 429) {
        await new Promise(r => setTimeout(r, 2000 * (i + 1)));
        continue;
      }
      return res;
    } catch {
      if (i < retries - 1) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  return null;
}

async function fetchTxsForJob(address: string): Promise<any[]> {
  const url = `https://toncenter.com/api/v2/getTransactions?address=${encodeURIComponent(address)}&limit=20&archival=true${API_KEY ? `&api_key=${API_KEY}` : ''}`;
  const res = await fetchWithRetry(url);
  if (!res || !res.ok) return [];
  try {
    const data = await res.json() as { ok: boolean; result?: any[] };
    if (!data.ok || !data.result) return [];
    return data.result.map((tx: any) => ({
      hash: tx.transaction_id?.hash ? Buffer.from(tx.transaction_id.hash, 'base64').toString('hex') : '',
      fee: (Number(tx.fee || 0) / 1e9).toFixed(4),
      utime: tx.utime || 0,
    }));
  } catch { return []; }
}

async function tryLighthouse(hash: string): Promise<{ text: string | null; source: string; ipfsUrl?: string; file?: { filename: string; mimeType: string; size: number }; encrypted?: boolean } | null> {
  if (!process.env.LIGHTHOUSE_API_KEY) return null;
  try {
    // Lighthouse search: list user files and match by filename prefix.
    // SDK uploads with `enact-<hash8>.json` (descriptions/results) or
    // `enact-file-<hash8>.<ext>` (binary files).
    const lhRes = await fetch('https://api.lighthouse.storage/api/user/files_uploaded?lastKey=null', {
      headers: { Authorization: `Bearer ${process.env.LIGHTHOUSE_API_KEY}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!lhRes.ok) return null;
    const data = await lhRes.json() as { fileList?: Array<{ cid: string; fileName: string; mimeType?: string; fileSizeInBytes?: string }> };
    if (!data.fileList?.length) return null;
    const tag = hash.slice(0, 8);
    const match = data.fileList.find(f => f.fileName?.startsWith(`enact-${tag}`) || f.fileName?.startsWith(`enact-file-${tag}`) || f.fileName?.startsWith(`enact-reason-${tag}`));
    if (!match) return null;
    const ipfsUrl = `${LH_GW}/${match.cid}`;
    const isJson = match.fileName.endsWith('.json');
    if (isJson) {
      const d = await fetchIpfsJson(match.cid);
      if (d) {
        if (d.type === 'job_result_encrypted') return { text: null, source: 'ipfs', ipfsUrl, encrypted: true };
        const text = d.description ?? d.result ?? d.reason ?? JSON.stringify(d);
        if (d.file?.cid) {
          const fUrl = d.file.ipfsUrl || `${LH_GW}/${d.file.cid}`;
          return { text, source: 'ipfs', ipfsUrl: fUrl, file: { filename: d.file.filename || 'file', mimeType: d.file.mimeType || 'application/octet-stream', size: d.file.size || 0 } };
        }
        return { text, source: 'ipfs', ipfsUrl };
      }
    }
    // Binary file path: filename like enact-file-<hash8>.<ext>
    return {
      text: null,
      source: 'ipfs',
      ipfsUrl,
      file: {
        filename: match.fileName,
        mimeType: match.mimeType || 'application/octet-stream',
        size: parseInt(match.fileSizeInBytes || '0'),
      },
    };
  } catch {
    return null;
  }
}

async function resolveContent(hash: string): Promise<{ text: string | null; source: string; ipfsUrl?: string; file?: { filename: string; mimeType: string; size: number }; encrypted?: boolean }> {
  if (!hash || hash === ZERO_HASH) return { text: null, source: 'hash' };
  try {
    const clean = hash.replace(/0+$/, '');
    if (clean.length >= 4) {
      const bytes = Buffer.from(clean, 'hex').toString('utf-8').replace(/\0/g, '');
      if (/^[\x20-\x7E\n\r\t]+$/.test(bytes) && bytes.length > 2) return { text: bytes, source: 'hex' };
    }
  } catch {}

  // Try Lighthouse first (primary provider in the SDK + bot).
  const lh = await tryLighthouse(hash);
  if (lh) return lh;

  if (process.env.PINATA_JWT) {
    try {
      if (!/^[0-9a-fA-F]{1,64}$/.test(hash)) return { text: null, source: 'hash' };
      const url = `https://api.pinata.cloud/data/pinList?status=pinned&pageLimit=5&metadata[keyvalues]={"descHash":{"value":"${hash}","op":"eq"}}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.PINATA_JWT}` }, signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const pins = await res.json() as { rows: Array<{ ipfs_pin_hash: string; metadata?: { keyvalues?: Record<string, string> } }> };
        if (pins.rows?.length > 0) {
          let fileResult: any = null;
          // Prefer JSON over file
          for (const pin of pins.rows) {
            const kv = pin.metadata?.keyvalues;
            const cid = pin.ipfs_pin_hash;
            const ipfsUrl = `${PINATA_GW}/${cid}`;
            if (kv?.type === 'file') {
              fileResult = { text: null, source: 'ipfs', ipfsUrl, file: { filename: kv.filename || 'file', mimeType: kv.mimeType || 'application/octet-stream', size: parseInt(kv.size || '0') } };
              continue;
            }
            const d = await fetchIpfsJson(cid);
            if (d) {
              if (d.type === 'job_result_encrypted') {
                return { text: null, source: 'ipfs', ipfsUrl, encrypted: true } as any;
              }
              const text = d.description ?? d.result ?? d.reason ?? JSON.stringify(d);
              if (d.file?.cid) {
                const fUrl = d.file.ipfsUrl || `${PINATA_GW}/${d.file.cid}`;
                const mime = d.file.mimeType || 'application/octet-stream';
                return { text, source: 'ipfs', ipfsUrl: fUrl, file: { filename: d.file.filename || 'file', mimeType: mime, size: d.file.size || 0 } };
              }
              return { text, source: 'ipfs', ipfsUrl };
            }
          }
          if (fileResult) return fileResult;
        }
      }
    } catch {}
  }
  // Last resort: try searching by name for file uploads
  if (process.env.PINATA_JWT) {
    try {
      const nameUrl = `https://api.pinata.cloud/data/pinList?status=pinned&pageLimit=1&metadata[name]=enact-file-${hash.slice(0, 8)}`;
      const nameRes = await fetch(nameUrl, { headers: { Authorization: `Bearer ${process.env.PINATA_JWT}` }, signal: AbortSignal.timeout(5000) });
      if (nameRes.ok) {
        const namePins = await nameRes.json() as { rows: Array<{ ipfs_pin_hash: string; metadata?: { keyvalues?: Record<string, string> } }> };
        if (namePins.rows?.length > 0) {
          const pin = namePins.rows[0];
          const cid = pin.ipfs_pin_hash;
          const ipfsUrl = `${PINATA_GW}/${cid}`;
          const kv = pin.metadata?.keyvalues;
          if (kv?.type === 'file') {
            return {
              text: null, source: 'ipfs', ipfsUrl,
              file: { filename: kv.filename || 'file', mimeType: kv.mimeType || 'application/octet-stream', size: parseInt(kv.size || '0') },
            };
          }
          return { text: null, source: 'ipfs', ipfsUrl };
        }
      }
    } catch {}
  }
  return { text: null, source: 'hash' };
}

// Permanent cache for terminal jobs in RPC mode
const terminalCache = new Map<string, any>();

async function fetchFromRPC() {
  const client = new EnactClient({ apiKey: API_KEY });
  const [tonCount, jettonCount] = await Promise.all([
    client.getJobCount(),
    client.getJettonJobCount().catch(() => 0),
  ]);

  const fetchJob = async (id: number, factory: string, type: 'ton' | 'usdt') => {
    const cacheKey = `${factory}:${id}`;
    const cached = terminalCache.get(cacheKey);
    if (cached) return cached;

    // Retry up to 3 times for 429 errors
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const addr = await client.getJobAddress(id, factory);
        const status = await client.getJobStatus(addr);
        const txs = await fetchTxsForJob(addr);
        const effectiveCreatedAt = status.createdAt || (txs.length > 0 ? txs[txs.length - 1].utime : 0);

        const reasonHash = (status as any).reasonHash || '';
        const [desc, result, reasonResolved] = await Promise.all([
          resolveContent(status.descHash),
          resolveContent(status.resultHash),
          resolveContent(reasonHash),
        ]);

        const job = {
          ...status,
          createdAt: effectiveCreatedAt,
          type,
          budget: status.budget.toString(),
          budgetFormatted: type === 'usdt' ? `${(Number(status.budget) / 1e6).toFixed(2)} USDT` : `${(Number(status.budget) / 1e9).toFixed(2)} TON`,
          description: desc,
          resultContent: result,
          reasonContent: reasonResolved,
          hasFile: !!(desc.file || result.file),
          transactions: txs,
        };

        const stateName = ['OPEN','FUNDED','SUBMITTED','COMPLETED','DISPUTED','CANCELLED'][status.state];
        if (['COMPLETED','DISPUTED','CANCELLED'].includes(stateName ?? '')) {
          terminalCache.set(cacheKey, job);
        }
        return job;
      } catch (err: unknown) {
        const is429 = err instanceof Error && err.message?.includes('429');
        if (is429 && attempt < 2) {
          await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
          continue;
        }
        return null;
      }
    }
    return null;
  };

  // Batch by 5
  const allItems = [
    ...Array.from({ length: tonCount }, (_, i) => ({ id: i, factory: FACTORY, type: 'ton' as const })),
    ...Array.from({ length: jettonCount }, (_, i) => ({ id: i, factory: JETTON_FACTORY, type: 'usdt' as const })),
  ];

  const results: any[] = [];
  for (let i = 0; i < allItems.length; i += 3) {
    const batch = allItems.slice(i, i + 3);
    const batchResults = await Promise.all(batch.map(item => fetchJob(item.id, item.factory, item.type)));
    results.push(...batchResults);
  }

  const tonJobs = results.filter(r => r && r.type === 'ton');
  const jettonJobs = results.filter(r => r && r.type === 'usdt');

  return {
    tonJobs, jettonJobs,
    factories: { ton: { address: FACTORY, jobCount: tonCount }, jetton: { address: JETTON_FACTORY, jobCount: jettonCount } },
    lastUpdated: Date.now(),
  };
}

// ─── In-memory cache to reduce Supabase egress ───

let responseCache: { data: any; fetchedAt: number } | null = null;
const CACHE_TTL = 1_000; // 1 second — minimal cache, RT triggers refetch on activity

// ─── API Handler ───

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  try {
    const now = Date.now();
    if (responseCache && now - responseCache.fetchedAt < CACHE_TTL) {
      return NextResponse.json(responseCache.data, {
        headers: { 'Cache-Control': 'public, max-age=5, stale-while-revalidate=10' },
      });
    }

    let data;
    try {
      data = await fetchFromSupabase();
    } catch {
      data = await fetchFromRPC();
    }

    responseCache = { data, fetchedAt: now };

    return NextResponse.json(data, {
      headers: {
        'Cache-Control': 'public, max-age=5, stale-while-revalidate=10',
        'X-Enact-Lighthouse': process.env.LIGHTHOUSE_API_KEY ? 'on' : 'off',
        'X-Enact-LhSubdomain': process.env.LIGHTHOUSE_GATEWAY_SUBDOMAIN ? 'on' : 'off',
        'X-Enact-Pinata': process.env.PINATA_JWT ? 'on' : 'off',
        'X-Enact-Build': 'per-provider-gw-v4',
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
