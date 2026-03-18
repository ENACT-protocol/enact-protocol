import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { EnactClient } from '@enact-protocol/sdk';

const FACTORY = 'EQAFHodWCzrYJTbrbJp1lMDQLfypTHoJCd0UcerjsdxPECjX';
const JETTON_FACTORY = 'EQCgYmwi8uwrG7I6bI3Cdv0ct-bAB1jZ0DQ7C3dX3MYn6VTj';
const API_KEY = process.env.TONCENTER_API_KEY || '';

interface CachedResponse { data: any; timestamp: number; }
let responseCache: CachedResponse | null = null;
const RESPONSE_TTL = 10_000; // 10s cache

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

  const [{ data: jobs, error: jobsErr }, { data: txs, error: txsErr }, { data: activity, error: actErr }] = await Promise.all([
    sb.from('jobs').select('*').order('created_at', { ascending: false }),
    sb.from('transactions').select('*').order('utime', { ascending: false }),
    sb.from('activity_events').select('*').order('time', { ascending: false }),
  ]);

  if (jobsErr || !jobs) throw new Error(`Supabase jobs error: ${jobsErr?.message}`);

  // Group transactions by job address
  const txByJob = new Map<string, any[]>();
  for (const tx of (txs ?? [])) {
    const arr = txByJob.get(tx.job_address) ?? [];
    arr.push({ hash: tx.tx_hash, fee: tx.fee, utime: tx.utime });
    txByJob.set(tx.job_address, arr);
  }

  // Transform to frontend format
  const transform = (j: any) => ({
    jobId: j.job_id,
    address: j.address,
    type: j.factory_type,
    state: j.state,
    stateName: j.state_name,
    client: j.client,
    provider: j.provider,
    evaluator: j.evaluator,
    budget: String(j.budget),
    budgetFormatted: j.budget_formatted,
    descHash: j.desc_hash,
    resultHash: j.result_hash,
    timeout: j.timeout,
    createdAt: j.created_at,
    evalTimeout: j.eval_timeout,
    submittedAt: j.submitted_at,
    resultType: j.result_type,
    description: j.description_text ? { text: j.description_text, source: j.description_ipfs_url ? 'ipfs' : 'hex', ipfsUrl: j.description_ipfs_url } : { text: null, source: 'hash' },
    resultContent: j.result_text ? { text: j.result_text, source: j.result_ipfs_url ? 'ipfs' : 'hex', ipfsUrl: j.result_ipfs_url } : { text: null, source: 'hash' },
    reasonContent: j.reason_text ? { text: j.reason_text, source: 'hex' } : { text: null, source: 'hash' },
    transactions: txByJob.get(j.address) ?? [],
  });

  const tonJobs = jobs.filter((j: any) => j.factory_type === 'ton').map(transform);
  const jettonJobs = jobs.filter((j: any) => j.factory_type === 'usdt').map(transform);

  return {
    tonJobs,
    jettonJobs,
    factories: {
      ton: { address: FACTORY, jobCount: tonJobs.length },
      jetton: { address: JETTON_FACTORY, jobCount: jettonJobs.length },
    },
    lastUpdated: Date.now(),
  };
}

// ─── RPC Fallback (existing logic, simplified) ───

async function fetchFromRPC() {
  const client = new EnactClient({ apiKey: API_KEY });
  const [tonCount, jettonCount] = await Promise.all([
    client.getJobCount(),
    client.getJettonJobCount().catch(() => 0),
  ]);

  const fetchJob = async (id: number, factory: string, type: 'ton' | 'usdt') => {
    try {
      const addr = await client.getJobAddress(id, factory);
      const status = await client.getJobStatus(addr);
      return {
        ...status,
        type,
        budget: status.budget.toString(),
        budgetFormatted: type === 'usdt' ? `${(Number(status.budget) / 1e6).toFixed(2)} USDT` : `${(Number(status.budget) / 1e9).toFixed(2)} TON`,
        description: { text: null, source: 'hash' as const },
        resultContent: { text: null, source: 'hash' as const },
        reasonContent: { text: null, source: 'hash' as const },
        transactions: [],
      };
    } catch { return null; }
  };

  const results = await Promise.all([
    ...Array.from({ length: tonCount }, (_, i) => fetchJob(i, FACTORY, 'ton')),
    ...Array.from({ length: jettonCount }, (_, i) => fetchJob(i, JETTON_FACTORY, 'usdt')),
  ]);

  const tonJobs = results.filter(r => r && r.type === 'ton');
  const jettonJobs = results.filter(r => r && r.type === 'usdt');

  return {
    tonJobs, jettonJobs,
    factories: { ton: { address: FACTORY, jobCount: tonCount }, jetton: { address: JETTON_FACTORY, jobCount: jettonCount } },
    lastUpdated: Date.now(),
  };
}

// ─── API Handler ───

export async function GET() {
  try {
    if (responseCache && Date.now() - responseCache.timestamp < RESPONSE_TTL) {
      return NextResponse.json(responseCache.data);
    }

    let data;
    try {
      data = await fetchFromSupabase();
    } catch {
      // Fallback to RPC
      data = await fetchFromRPC();
    }

    responseCache = { data, timestamp: Date.now() };
    return NextResponse.json(data);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
