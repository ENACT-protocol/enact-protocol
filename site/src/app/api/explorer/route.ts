import { NextResponse } from 'next/server';
import { EnactClient } from '@enact-protocol/sdk';

const FACTORY = 'EQAFHodWCzrYJTbrbJp1lMDQLfypTHoJCd0UcerjsdxPECjX';
const JETTON_FACTORY = 'EQCgYmwi8uwrG7I6bI3Cdv0ct-bAB1jZ0DQ7C3dX3MYn6VTj';
const PINATA_GW = process.env.PINATA_GATEWAY || 'https://green-known-basilisk-878.mypinata.cloud/ipfs';
const ZERO_HASH = '0'.repeat(64);
const API_KEY = process.env.TONCENTER_API_KEY || '';

interface CachedData { data: any; timestamp: number; }
let cache: CachedData | null = null;
const CACHE_TTL = 30_000;

const cidCache = new Map<string, { cid: string; text: string | null }>();

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
              cidCache.set(hash, { cid, text });
              return { text, source: 'ipfs', ipfsUrl };
            }
          } catch {}
          cidCache.set(hash, { cid, text: null });
          return { text: null, source: 'ipfs', ipfsUrl };
        }
      }
    } catch {}
  }
  return { text: null, source: 'hash' };
}

// Fetch transactions for a job contract address from toncenter
interface TxInfo { hash: string; fee: string; utime: number; }

async function fetchJobTransactions(jobAddress: string): Promise<TxInfo[]> {
  try {
    const url = `https://toncenter.com/api/v2/getTransactions?address=${encodeURIComponent(jobAddress)}&limit=20&archival=true${API_KEY ? `&api_key=${API_KEY}` : ''}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const data = await res.json();
    if (!data.ok || !data.result) return [];
    return data.result.map((tx: any) => {
      const hash = tx.transaction_id?.hash ? Buffer.from(tx.transaction_id.hash, 'base64').toString('hex') : '';
      // Real gas = in_msg.value - sum(out_msgs.value that go back as excess)
      const inValue = Number(tx.in_msg?.value || 0);
      const outValue = (tx.out_msgs || []).reduce((s: number, m: any) => s + Number(m.value || 0), 0);
      const realGas = Math.max(0, inValue - outValue);
      return {
        hash,
        fee: (realGas / 1e9).toFixed(3),
        utime: tx.utime || 0,
      };
    });
  } catch { return []; }
}

async function fetchAllJobs() {
  const client = new EnactClient({ apiKey: API_KEY });

  const [tonCount, jettonCount] = await Promise.all([
    client.getJobCount(),
    client.getJettonJobCount().catch(() => 0),
  ]);

  const fetchJob = async (id: number, factory: string, type: 'ton' | 'usdt') => {
    try {
      const addr = await client.getJobAddress(id, factory);
      const status = await client.getJobStatus(addr);

      const [desc, result, reason, txs] = await Promise.all([
        resolveContent(status.descHash),
        resolveContent(status.resultHash),
        status.state >= 3 ? resolveContent(
          (() => { try { const r = (status as any).reason ?? ''; if (r && r !== '0') return typeof r === 'string' ? r.padStart(64, '0') : ''; } catch {} return ''; })()
        ) : Promise.resolve({ text: null, source: 'hash' as const }),
        fetchJobTransactions(addr),
      ]);

      return {
        ...status,
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
    } catch {
      return null;
    }
  };

  const tonPromises = Array.from({ length: tonCount }, (_, i) => fetchJob(i, FACTORY, 'ton'));
  const jettonPromises = Array.from({ length: jettonCount }, (_, i) => fetchJob(i, JETTON_FACTORY, 'usdt'));

  const [tonResults, jettonResults] = await Promise.all([
    Promise.all(tonPromises),
    Promise.all(jettonPromises),
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
    if (cache && Date.now() - cache.timestamp < CACHE_TTL) {
      return NextResponse.json(cache.data);
    }
    const data = await fetchAllJobs();
    cache = { data, timestamp: Date.now() };
    return NextResponse.json(data);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
