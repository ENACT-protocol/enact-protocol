import { NextResponse } from 'next/server';
import { EnactClient } from '@enact-protocol/sdk';

const FACTORY = 'EQAFHodWCzrYJTbrbJp1lMDQLfypTHoJCd0UcerjsdxPECjX';
const JETTON_FACTORY = 'EQCgYmwi8uwrG7I6bI3Cdv0ct-bAB1jZ0DQ7C3dX3MYn6VTj';

interface CachedData {
  data: any;
  timestamp: number;
}

let cache: CachedData | null = null;
const CACHE_TTL = 30_000; // 30 seconds

async function fetchAllJobs() {
  const client = new EnactClient({ apiKey: process.env.TONCENTER_API_KEY });

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
        budgetFormatted: type === 'usdt'
          ? `${(Number(status.budget) / 1e6).toFixed(2)} USDT`
          : `${(Number(status.budget) / 1e9).toFixed(2)} TON`,
      };
    } catch {
      return null;
    }
  };

  // Fetch all jobs in parallel batches of 8
  const tonJobs: any[] = [];
  const jettonJobs: any[] = [];

  const tonPromises = Array.from({ length: tonCount }, (_, i) => fetchJob(i, FACTORY, 'ton'));
  const jettonPromises = Array.from({ length: jettonCount }, (_, i) => fetchJob(i, JETTON_FACTORY, 'usdt'));

  const [tonResults, jettonResults] = await Promise.all([
    Promise.all(tonPromises),
    Promise.all(jettonPromises),
  ]);

  tonResults.forEach(r => { if (r) tonJobs.push(r); });
  jettonResults.forEach(r => { if (r) jettonJobs.push(r); });

  return {
    tonJobs,
    jettonJobs,
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
