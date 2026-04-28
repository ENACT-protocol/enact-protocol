import { TonClient } from '@ton/ton';
import { Address } from '@ton/core';
import { FACTORY, JETTON_FACTORY, STATE_NAMES } from './types';
import { upsertJob, upsertTransaction, insertActivity, getIndexerState, updateIndexerState, getExistingJobAddresses } from './supabase';
import { resolveContent } from './content';

const API_KEY = process.env.TONCENTER_API_KEY || '';

function log(msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

async function getClient(): Promise<TonClient> {
  return new TonClient({
    endpoint: 'https://toncenter.com/api/v2/jsonRPC',
    apiKey: API_KEY,
  });
}

async function fetchTransactions(address: string): Promise<any[]> {
  try {
    const url = `https://toncenter.com/api/v2/getTransactions?address=${encodeURIComponent(address)}&limit=20&archival=true${API_KEY ? `&api_key=${API_KEY}` : ''}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const data = await res.json() as { ok: boolean; result?: any[] };
    return data.ok ? (data.result ?? []) : [];
  } catch { return []; }
}

async function indexJob(client: TonClient, factory: string, jobId: number, type: 'ton' | 'usdt') {
  try {
    // Get job address
    const addrResult = await client.runMethod(Address.parse(factory), 'get_job_address', [
      { type: 'int', value: BigInt(jobId) },
    ]);
    const jobAddr = addrResult.stack.readAddress().toString();

    // Get job data
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

    // Resolve content
    const descHashHex = descHash.toString(16).padStart(64, '0');
    const resultHashHex = resultHash.toString(16).padStart(64, '0');
    const [descContent, resultContent, reasonContent] = await Promise.all([
      resolveContent(descHashHex),
      resolveContent(resultHashHex),
      state >= 3 ? resolveContent(reason.toString(16).padStart(64, '0')) : Promise.resolve({ text: null, ipfsUrl: null }),
    ]);

    // Fetch transactions
    const rawTxs = await fetchTransactions(jobAddr);
    const txs = rawTxs.map((tx: any) => ({
      hash: tx.transaction_id?.hash ? Buffer.from(tx.transaction_id.hash, 'base64').toString('hex') : '',
      fee: (Number(tx.fee || 0) / 1e9).toFixed(4),
      utime: tx.utime || 0,
      opcode: null as number | null,
      from: tx.in_msg?.source || null,
    }));

    // Use first tx utime as createdAt for OPEN jobs
    const effectiveCreatedAt = createdAt || (txs.length > 0 ? txs[txs.length - 1].utime : 0);

    // Upsert job
    await upsertJob({
      job_id: jobId,
      factory_type: type,
      address: jobAddr,
      factory_address: factory,
      state,
      state_name: stateName,
      client: clientAddr.toString(uf),
      provider: providerAddr?.toString(uf) ?? null,
      evaluator: evaluatorAddr.toString(uf),
      budget: budgetNum,
      budget_formatted: budgetFormatted,
      desc_hash: descHashHex,
      result_hash: resultHashHex,
      timeout,
      created_at: effectiveCreatedAt,
      eval_timeout: evalTimeout,
      submitted_at: submittedAt,
      result_type: resultType,
      description_text: descContent.text,
      description_ipfs_url: descContent.ipfsUrl,
      result_text: resultContent.text,
      result_ipfs_url: resultContent.ipfsUrl,
      reason_text: reasonContent.text,
    });

    // Upsert transactions
    for (const tx of txs) {
      if (!tx.hash) continue;
      await upsertTransaction({
        job_address: jobAddr,
        tx_hash: tx.hash,
        fee: tx.fee,
        utime: tx.utime,
        opcode: tx.opcode,
        event_type: null,
        from_address: tx.from,
      });
    }

    // Build activity events from txs (chronological = reversed)
    const chronTxs = [...txs].reverse();
    const isUsdt = type === 'usdt';

    // Created
    if (effectiveCreatedAt && chronTxs[0]) {
      await insertActivity({ job_id: jobId, factory_type: type, job_address: jobAddr, event: 'Created', status: 'OPEN', time: chronTxs[0].utime || effectiveCreatedAt, amount: budgetFormatted, from_address: clientAddr.toString(uf), tx_hash: chronTxs[0].hash });
    }
    // Funded
    const fundIdx = isUsdt ? 2 : 1;
    if (state >= 1 && chronTxs[fundIdx]) {
      await insertActivity({ job_id: jobId, factory_type: type, job_address: jobAddr, event: 'Funded', status: 'FUNDED', time: chronTxs[fundIdx].utime, amount: budgetFormatted, from_address: clientAddr.toString(uf), tx_hash: chronTxs[fundIdx].hash });
    }
    // Taken + Submitted
    if (submittedAt) {
      const subIdx = isUsdt ? 3 : 2;
      if (providerAddr && chronTxs[subIdx]) {
        await insertActivity({ job_id: jobId, factory_type: type, job_address: jobAddr, event: 'Taken', status: 'FUNDED', time: chronTxs[subIdx].utime - 1, amount: null, from_address: providerAddr.toString(uf), tx_hash: chronTxs[subIdx].hash });
      }
      if (chronTxs[subIdx]) {
        await insertActivity({ job_id: jobId, factory_type: type, job_address: jobAddr, event: 'Submitted', status: 'SUBMITTED', time: chronTxs[subIdx].utime, amount: budgetFormatted, from_address: providerAddr?.toString(uf) ?? null, tx_hash: chronTxs[subIdx].hash });
      }
    }
    // Terminal
    const lastTx = chronTxs[chronTxs.length - 1];
    if (stateName === 'COMPLETED' && lastTx) {
      await insertActivity({ job_id: jobId, factory_type: type, job_address: jobAddr, event: 'Approved', status: 'COMPLETED', time: lastTx.utime, amount: `${budgetFormatted} → Provider`, from_address: evaluatorAddr.toString(uf), tx_hash: lastTx.hash });
    }
    if (stateName === 'CANCELLED' && lastTx) {
      await insertActivity({ job_id: jobId, factory_type: type, job_address: jobAddr, event: 'Cancelled', status: 'CANCELLED', time: lastTx.utime, amount: `${budgetFormatted} → Client`, from_address: clientAddr.toString(uf), tx_hash: lastTx.hash });
    }
    if (stateName === 'DISPUTED' && lastTx) {
      await insertActivity({ job_id: jobId, factory_type: type, job_address: jobAddr, event: 'Rejected', status: 'DISPUTED', time: lastTx.utime, amount: budgetFormatted, from_address: evaluatorAddr.toString(uf), tx_hash: lastTx.hash });
    }

    log(`  Indexed ${type.toUpperCase()} #${jobId} (${stateName}) at ${jobAddr.slice(0, 12)}...`);
  } catch (err: any) {
    log(`  Error indexing ${type} #${jobId}: ${err.message}`);
  }
}

export async function backfill() {
  log('Starting backfill...');
  const client = await getClient();
  const existing = await getExistingJobAddresses();

  for (const { factory, type } of [
    { factory: FACTORY, type: 'ton' as const },
    { factory: JETTON_FACTORY, type: 'usdt' as const },
  ]) {
    const countResult = await client.runMethod(Address.parse(factory), 'get_next_job_id');
    const count = countResult.stack.readNumber();
    const state = await getIndexerState(factory);
    const lastCount = state?.last_job_count ?? 0;

    log(`${type.toUpperCase()} factory: ${count} jobs (${lastCount} previously indexed)`);

    // Index all jobs (re-index non-terminal ones, skip terminal that exist)
    for (let i = 0; i < count; i++) {
      // Rate limit: small delay between jobs
      if (i > 0) await new Promise(r => setTimeout(r, 500));
      await indexJob(client, factory, i, type);
    }

    await updateIndexerState(factory, count);
  }

  log('Backfill complete.');
}
