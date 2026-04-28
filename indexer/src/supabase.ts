import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { JobRow, TxRow, ActivityRow } from './types';

let client: SupabaseClient;

export function getSupabase(): SupabaseClient {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY required');
    client = createClient(url, key);
  }
  return client;
}

export async function upsertJob(job: JobRow) {
  const sb = getSupabase();
  const { error } = await sb.from('jobs').upsert(job, { onConflict: 'address' });
  if (error) console.error('upsertJob error:', error.message);
}

export async function upsertTransaction(tx: TxRow) {
  const sb = getSupabase();
  const { error } = await sb.from('transactions').upsert(tx, { onConflict: 'tx_hash' });
  if (error && !error.message.includes('duplicate')) console.error('upsertTx error:', error.message);
}

export async function insertActivity(event: ActivityRow) {
  const sb = getSupabase();
  // Check if already exists (by job_address + event + time)
  const { data: existing } = await sb
    .from('activity_events')
    .select('id')
    .eq('job_address', event.job_address)
    .eq('event', event.event)
    .eq('time', event.time)
    .limit(1);
  if (existing && existing.length > 0) return;
  const { error } = await sb.from('activity_events').insert(event);
  if (error) console.error('insertActivity error:', error.message);
}

export async function getIndexerState(factory: string) {
  const sb = getSupabase();
  const { data } = await sb.from('indexer_state').select('*').eq('factory_address', factory).single();
  return data;
}

export async function updateIndexerState(factory: string, jobCount: number) {
  const sb = getSupabase();
  await sb.from('indexer_state').upsert({
    factory_address: factory,
    last_job_count: jobCount,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'factory_address' });
}

export async function getExistingJobAddresses(): Promise<Set<string>> {
  const sb = getSupabase();
  const { data } = await sb.from('jobs').select('address');
  return new Set((data ?? []).map((j: any) => j.address));
}
