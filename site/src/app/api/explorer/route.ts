import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { EnactClient } from '@enact-protocol/sdk';

const FACTORY = 'EQAFHodWCzrYJTbrbJp1lMDQLfypTHoJCd0UcerjsdxPECjX';
const JETTON_FACTORY = 'EQCgYmwi8uwrG7I6bI3Cdv0ct-bAB1jZ0DQ7C3dX3MYn6VTj';
const API_KEY = process.env.TONCENTER_API_KEY || '';
const PINATA_GW = process.env.PINATA_GATEWAY || 'https://green-known-basilisk-878.mypinata.cloud/ipfs';
const ZERO_HASH = '0'.repeat(64);

interface CachedResponse { data: any; timestamp: number; }
let responseCache: CachedResponse | null = null;
const RESPONSE_TTL = 15_000; // 15s in-memory cache per serverless instance

// ─── Supabase Read ───

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
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

  const transform = (j: any) => ({
    jobId: j.job_id, address: j.address, type: j.factory_type,
    state: j.state, stateName: j.state_name,
    client: j.client, provider: j.provider, evaluator: j.evaluator,
    budget: String(j.budget), budgetFormatted: j.budget_formatted,
    descHash: j.desc_hash, resultHash: j.result_hash,
    timeout: j.timeout, createdAt: j.created_at,
    evalTimeout: j.eval_timeout, submittedAt: j.submitted_at,
    resultType: j.result_type,
    description: j.description_text ? { text: j.description_text, source: j.description_ipfs_url ? 'ipfs' : 'hex', ipfsUrl: j.description_ipfs_url } : { text: null, source: 'hash' },
    resultContent: j.result_text ? { text: j.result_text, source: j.result_ipfs_url ? 'ipfs' : 'hex', ipfsUrl: j.result_ipfs_url } : { text: null, source: 'hash' },
    reasonContent: j.reason_text ? { text: j.reason_text, source: 'hex' } : { text: null, source: 'hash' },
    transactions: txByJob.get(j.address) ?? [],
  });

  const tonJobs = jobs.filter((j: any) => j.factory_type === 'ton').map(transform);
  const jettonJobs = jobs.filter((j: any) => j.factory_type === 'usdt').map(transform);

  return {
    tonJobs, jettonJobs,
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

async function resolveContent(hash: string): Promise<{ text: string | null; source: string; ipfsUrl?: string; file?: { filename: string; mimeType: string; size: number } }> {
  if (!hash || hash === ZERO_HASH) return { text: null, source: 'hash' };
  try {
    const clean = hash.replace(/0+$/, '');
    if (clean.length >= 4) {
      const bytes = Buffer.from(clean, 'hex').toString('utf-8').replace(/\0/g, '');
      if (/^[\x20-\x7E\n\r\t]+$/.test(bytes) && bytes.length > 2) return { text: bytes, source: 'hex' };
    }
  } catch {}
  if (process.env.PINATA_JWT) {
    try {
      if (!/^[0-9a-fA-F]{1,64}$/.test(hash)) return { text: null, source: 'hash' };
      const url = `https://api.pinata.cloud/data/pinList?status=pinned&pageLimit=1&metadata[keyvalues]={"descHash":{"value":"${hash}","op":"eq"}}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.PINATA_JWT}` }, signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const pins = await res.json() as { rows: Array<{ ipfs_pin_hash: string; metadata?: { keyvalues?: Record<string, string> } }> };
        if (pins.rows?.length > 0) {
          const pin = pins.rows[0];
          const cid = pin.ipfs_pin_hash;
          const ipfsUrl = `${PINATA_GW}/${cid}`;
          const kv = pin.metadata?.keyvalues;

          // Check if it's a file upload
          if (kv?.type === 'file') {
            return {
              text: null, source: 'ipfs', ipfsUrl,
              file: { filename: kv.filename || 'file', mimeType: kv.mimeType || 'application/octet-stream', size: parseInt(kv.size || '0') },
            };
          }

          // Regular JSON content (may contain file reference)
          try {
            const cr = await fetch(ipfsUrl, { signal: AbortSignal.timeout(5000) });
            if (cr.ok) {
              const d = await cr.json() as Record<string, any>;
              const text = d.description ?? d.result ?? d.reason ?? JSON.stringify(d);
              // Check if JSON contains a file reference
              if (d.file && d.file.cid) {
                const fileIpfsUrl = d.file.ipfsUrl || `${PINATA_GW}/${d.file.cid}`;
                const ext = (d.file.filename || '').split('.').pop()?.toLowerCase() || '';
                const imgExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
                const mimeType = imgExts.includes(ext) ? `image/${ext === 'jpg' ? 'jpeg' : ext}` : 'application/octet-stream';
                return { text, source: 'ipfs', ipfsUrl: fileIpfsUrl, file: { filename: d.file.filename || 'file', mimeType, size: 0 } };
              }
              return { text, source: 'ipfs', ipfsUrl };
            }
          } catch {}
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

        const [desc, result] = await Promise.all([
          resolveContent(status.descHash),
          resolveContent(status.resultHash),
        ]);

        const job = {
          ...status,
          createdAt: effectiveCreatedAt,
          type,
          budget: status.budget.toString(),
          budgetFormatted: type === 'usdt' ? `${(Number(status.budget) / 1e6).toFixed(2)} USDT` : `${(Number(status.budget) / 1e9).toFixed(2)} TON`,
          description: desc,
          resultContent: result,
          reasonContent: { text: null, source: 'hash' },
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

// ─── API Handler ───

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  try {
    if (responseCache && Date.now() - responseCache.timestamp < RESPONSE_TTL) {
      return NextResponse.json(responseCache.data, {
        headers: { 'Cache-Control': 'no-store, max-age=0' },
      });
    }

    let data;
    try {
      data = await fetchFromSupabase();
    } catch {
      data = await fetchFromRPC();
    }

    responseCache = { data, timestamp: Date.now() };
    return NextResponse.json(data, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
