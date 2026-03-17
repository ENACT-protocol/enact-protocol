import { NextResponse } from 'next/server';
import { EnactClient } from '@enact-protocol/sdk';

const FACTORY = 'EQAFHodWCzrYJTbrbJp1lMDQLfypTHoJCd0UcerjsdxPECjX';
const JETTON_FACTORY = 'EQCgYmwi8uwrG7I6bI3Cdv0ct-bAB1jZ0DQ7C3dX3MYn6VTj';
const PINATA_GW = process.env.PINATA_GATEWAY || 'https://green-known-basilisk-878.mypinata.cloud/ipfs';
const ZERO_HASH = '0'.repeat(64);
const API_KEY = process.env.TONCENTER_API_KEY || '';
const TERMINAL_STATES = ['COMPLETED', 'DISPUTED', 'CANCELLED'];

// ─── Caches ───

interface CachedResponse { data: any; timestamp: number; }
let responseCache: CachedResponse | null = null;
const RESPONSE_TTL = 30_000;

// Permanent cache for terminal-state jobs (they never change)
const permanentJobCache = new Map<string, any>(); // key = "factory:id"

// CID cache for IPFS lookups
const CID_CACHE_MAX = 500;
const cidCache = new Map<string, { cid: string; text: string | null }>();
function cidCacheSet(key: string, value: { cid: string; text: string | null }) {
  if (cidCache.size >= CID_CACHE_MAX) {
    const firstKey = cidCache.keys().next().value;
    if (firstKey !== undefined) cidCache.delete(firstKey);
  }
  cidCache.set(key, value);
}

// ─── Content Resolution ───

async function resolveContent(hash: string): Promise<{
  text: string | null; source: 'hex' | 'ipfs' | 'hash'; ipfsUrl?: string;
}> {
  if (!hash || hash === ZERO_HASH) return { text: null, source: 'hash' };
  const cached = cidCache.get(hash);
  if (cached) return { text: cached.text, source: 'ipfs', ipfsUrl: `${PINATA_GW}/${cached.cid}` };
  try {
    const clean = hash.replace(/0+$/, '');
    if (clean.length >= 4) {
      const bytes = Buffer.from(clean, 'hex').toString('utf-8').replace(/\0/g, '');
      if (/^[\x20-\x7E\n\r\t]+$/.test(bytes) && bytes.length > 2) return { text: bytes, source: 'hex' };
    }
  } catch {}
  if (process.env.PINATA_JWT) {
    try {
      const url = `https://api.pinata.cloud/data/pinList?status=pinned&pageLimit=1&metadata[keyvalues]={"descHash":{"value":"${hash}","op":"eq"}}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.PINATA_JWT}` }, signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const pins = await res.json() as { rows: Array<{ ipfs_pin_hash: string }> };
        if (pins.rows?.length > 0) {
          const cid = pins.rows[0].ipfs_pin_hash;
          const ipfsUrl = `${PINATA_GW}/${cid}`;
          try {
            const contentRes = await fetch(ipfsUrl, { signal: AbortSignal.timeout(5000) });
            if (contentRes.ok) {
              const data = await contentRes.json();
              const text = data.description ?? data.result ?? data.reason ?? JSON.stringify(data);
              cidCacheSet(hash, { cid, text });
              return { text, source: 'ipfs', ipfsUrl };
            }
          } catch {}
          cidCacheSet(hash, { cid, text: null });
          return { text: null, source: 'ipfs', ipfsUrl };
        }
      }
    } catch {}
  }
  return { text: null, source: 'hash' };
}

// ─── Transaction Fetching ───

interface TxInfo { hash: string; fee: string; utime: number; }

async function fetchJobTransactions(jobAddress: string, retries = 2): Promise<TxInfo[]> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const url = `https://toncenter.com/api/v2/getTransactions?address=${encodeURIComponent(jobAddress)}&limit=20&archival=true${API_KEY ? `&api_key=${API_KEY}` : ''}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (res.status === 429 && attempt < retries) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) return [];
      const data = await res.json();
      if (!data.ok || !data.result) return [];
      return data.result.map((tx: any) => ({
        hash: tx.transaction_id?.hash ? Buffer.from(tx.transaction_id.hash, 'base64').toString('hex') : '',
        fee: (Number(tx.fee || 0) / 1e9).toFixed(4),
        utime: tx.utime || 0,
      }));
    } catch {
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      return [];
    }
  }
  return [];
}

// ─── Job Fetching ───

async function fetchJob(client: EnactClient, id: number, factory: string, type: 'ton' | 'usdt') {
  const cacheKey = `${factory}:${id}`;

  // Return permanent cache for terminal jobs
  const cached = permanentJobCache.get(cacheKey);
  if (cached) return cached;

  try {
    const addr = await client.getJobAddress(id, factory);
    const status = await client.getJobStatus(addr);

    // Fetch transactions
    const txs = await fetchJobTransactions(addr);

    // For OPEN jobs: createdAt=0 in contract. Use first tx utime as creation time.
    let effectiveCreatedAt = status.createdAt;
    if (!effectiveCreatedAt && txs.length > 0) {
      // Oldest tx = last in array (API returns newest first)
      effectiveCreatedAt = txs[txs.length - 1].utime;
    }

    // Resolve content in parallel
    const [desc, result, reason] = await Promise.all([
      resolveContent(status.descHash),
      resolveContent(status.resultHash),
      status.state >= 3 ? resolveContent(
        (() => { try { const r = (status as any).reason ?? ''; if (r && r !== '0') return typeof r === 'string' ? r.padStart(64, '0') : ''; } catch {} return ''; })()
      ) : Promise.resolve({ text: null, source: 'hash' as const }),
    ]);

    const stateName = ['OPEN', 'FUNDED', 'SUBMITTED', 'COMPLETED', 'DISPUTED', 'CANCELLED'][status.state] ?? 'UNKNOWN';

    const job = {
      ...status,
      createdAt: effectiveCreatedAt,
      type,
      budget: status.budget.toString(),
      budgetFormatted: type === 'usdt'
        ? `${(Number(status.budget) / 1e6).toFixed(2)} USDT`
        : `${(Number(status.budget) / 1e9).toFixed(2)} TON`,
      description: desc,
      resultContent: result,
      reasonContent: reason,
      transactions: txs,
    };

    // Permanently cache terminal-state jobs
    if (TERMINAL_STATES.includes(stateName)) {
      permanentJobCache.set(cacheKey, job);
    }

    return job;
  } catch {
    return null;
  }
}

async function fetchAllJobs() {
  const client = new EnactClient({ apiKey: API_KEY });

  const [tonCount, jettonCount] = await Promise.all([
    client.getJobCount(),
    client.getJettonJobCount().catch(() => 0),
  ]);

  // Batch fetch to avoid rate limiting — 5 concurrent jobs max
  async function batchFetch(items: Array<{ id: number; factory: string; type: 'ton' | 'usdt' }>) {
    const results: any[] = [];
    for (let i = 0; i < items.length; i += 5) {
      const batch = items.slice(i, i + 5);
      const batchResults = await Promise.all(batch.map(item => fetchJob(client, item.id, item.factory, item.type)));
      results.push(...batchResults);
    }
    return results;
  }

  const tonItems = Array.from({ length: tonCount }, (_, i) => ({ id: i, factory: FACTORY, type: 'ton' as const }));
  const jettonItems = Array.from({ length: jettonCount }, (_, i) => ({ id: i, factory: JETTON_FACTORY, type: 'usdt' as const }));

  const [tonResults, jettonResults] = await Promise.all([
    batchFetch(tonItems),
    batchFetch(jettonItems),
  ]);

  return {
    tonJobs: tonResults.filter(Boolean),
    jettonJobs: jettonResults.filter(Boolean),
    factories: {
      ton: { address: FACTORY, jobCount: tonCount },
      jetton: { address: JETTON_FACTORY, jobCount: jettonCount },
    },
    lastUpdated: Date.now(),
  };
}

export async function GET() {
  try {
    if (responseCache && Date.now() - responseCache.timestamp < RESPONSE_TTL) {
      return NextResponse.json(responseCache.data);
    }
    const data = await fetchAllJobs();
    responseCache = { data, timestamp: Date.now() };
    return NextResponse.json(data);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
