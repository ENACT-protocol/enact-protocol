import { backfill } from './backfill';

const POLL_INTERVAL = 30_000; // 30 seconds

function log(msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

async function main() {
  log('ENACT Indexer starting...');

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
    process.exit(1);
  }

  // Initial full backfill
  await backfill();

  // Poll for new jobs periodically
  log(`Polling every ${POLL_INTERVAL / 1000}s for new jobs...`);
  setInterval(async () => {
    try {
      await backfill();
    } catch (err: any) {
      log(`Poll error: ${err.message}`);
    }
  }, POLL_INTERVAL);
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
