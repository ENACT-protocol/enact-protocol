/**
 * One-shot helper: move N TON from the PROVIDER_MNEMONIC wallet back to
 * the main WALLET_MNEMONIC wallet. Useful when the provider accumulated
 * test TON and the client needs funds for a fresh deploy + e2e run.
 *
 * Run: REBALANCE_TON=1.5 npx ts-node scripts/rebalance-provider.ts
 */
import {
    SendMode,
    TonClient,
    WalletContractV5R1,
    internal,
    toNano,
} from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

const MAIN = (process.env.WALLET_MNEMONIC ?? '').trim();
const PROVIDER = (process.env.PROVIDER_MNEMONIC ?? '').trim();
const ENDPOINT = process.env.TONCENTER_ENDPOINT ?? 'https://toncenter.com/api/v2/jsonRPC';
const API_KEY = process.env.TONCENTER_API_KEY ?? '';
const AMOUNT = process.env.REBALANCE_TON ?? '1.0';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function retry<T>(fn: () => Promise<T>, attempts = 10, delay = 6000): Promise<T> {
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (e: any) {
            if (i === attempts - 1) throw e;
            console.log(`  retry ${i + 1}/${attempts}: ${String(e.message ?? e).slice(0, 80)}`);
            await sleep(delay);
        }
    }
    throw new Error('unreachable');
}
async function main() {
    const client = new TonClient({ endpoint: ENDPOINT, apiKey: API_KEY });
    const mainKp = await mnemonicToPrivateKey(MAIN.split(/\s+/));
    const mainWallet = WalletContractV5R1.create({ publicKey: mainKp.publicKey, workchain: 0 });
    const pkp = await mnemonicToPrivateKey(PROVIDER.split(/\s+/));
    const providerWallet = WalletContractV5R1.create({ publicKey: pkp.publicKey, workchain: 0 });
    const pw = client.open(providerWallet);
    const seqno: number = await retry(() => pw.getSeqno());
    await retry(() =>
        pw.sendTransfer({
            seqno,
            secretKey: pkp.secretKey,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            messages: [internal({ to: mainWallet.address, value: toNano(AMOUNT), bounce: false })],
        }),
    );
    console.log(`sent ${AMOUNT} TON provider -> main, seqno ${seqno}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
