/**
 * Test Toncenter Streaming API v2 WebSocket
 * Usage: npx ts-node --skip-project scripts/test-streaming.ts
 */
import WebSocket from 'ws';

const API_KEY = process.env.TONCENTER_API_KEY || '';
const FACTORY = 'EQAFHodWCzrYJTbrbJp1lMDQLfypTHoJCd0UcerjsdxPECjX';
const JETTON_FACTORY = 'EQCgYmwi8uwrG7I6bI3Cdv0ct-bAB1jZ0DQ7C3dX3MYn6VTj';
const TONCENTER_HOT = 'EQDhR3ydd9dSxxpnbjKJfJEcOPP4bwjMDQ3Bkh9MJfFJuGkr';
const TON_FOUNDATION = 'EQDfD2pjvJQhshg6OBVAHo_3FpjhnGy8MbPw-HqNKJkSH3C0';

const WS_URL = API_KEY
  ? `wss://toncenter.com/api/streaming/v2/ws?api_key=${API_KEY}`
  : 'wss://toncenter.com/api/streaming/v2/ws';

console.log(`Connecting to: ${WS_URL.replace(API_KEY, API_KEY ? API_KEY.slice(0, 8) + '...' : 'no-key')}`);

let txCount = 0;
const t = () => new Date().toISOString().slice(11, 19);

function connect() {
  const ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log(`[${t()}] Connected!`);
    ws.send(JSON.stringify({
      operation: 'subscribe',
      id: '1',
      addresses: [FACTORY, JETTON_FACTORY, TONCENTER_HOT, TON_FOUNDATION],
      types: ['transactions'],
      min_finality: 'confirmed',
    }));
    console.log(`[${t()}] Subscribed to 4 addresses`);
    console.log(`[${t()}] Waiting for transactions...`);
  });

  ws.on('message', (raw: Buffer) => {
    try {
      const data = JSON.parse(raw.toString());
      if (data.id || data.result !== undefined) {
        console.log(`[${t()}] Response:`, JSON.stringify(data).slice(0, 150));
        return;
      }
      if (data.type === 'transactions' && data.transactions) {
        for (const tx of data.transactions) {
          txCount++;
          console.log(`[${t()}] TX #${txCount} | ${data.finality} | ${(tx.account || '').slice(0, 12)}... | hash: ${(tx.hash || '').slice(0, 12)}...`);
        }
      } else {
        console.log(`[${t()}] Event:`, JSON.stringify(data).slice(0, 150));
      }
    } catch (e: any) {
      console.log(`[${t()}] Parse err:`, e.message);
    }
  });

  ws.on('error', (err: Error) => {
    console.error(`[${t()}] Error:`, err.message);
  });

  ws.on('close', (code: number, reason: Buffer) => {
    console.log(`[${t()}] Closed: ${code} ${reason?.toString() || ''}`);
    console.log(`[${t()}] Reconnecting in 3s...`);
    setTimeout(connect, 3000);
  });
}

connect();

setInterval(() => {
  console.log(`[${t()}] --- ${txCount} transactions received so far ---`);
}, 30000);

process.on('SIGINT', () => { console.log('\nDone.'); process.exit(0); });
