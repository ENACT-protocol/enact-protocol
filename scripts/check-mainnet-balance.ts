/**
 * Quick mainnet balance probe. Uses WALLET_MNEMONIC from .env.local
 * and the mainnet endpoint to print the main wallet's EQ... address
 * and balance. No state-changing calls.
 */
import { TonClient, WalletContractV5R1 } from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

async function main() {
    const m = (process.env.WALLET_MNEMONIC ?? '').trim();
    const endpoint = process.env.TONCENTER_ENDPOINT ?? 'https://toncenter.com/api/v2/jsonRPC';
    const testnet = endpoint.includes('testnet');
    const kp = await mnemonicToPrivateKey(m.split(/\s+/));
    const wallet = WalletContractV5R1.create({ publicKey: kp.publicKey, workchain: 0 });
    const client = new TonClient({ endpoint, apiKey: process.env.TONCENTER_API_KEY ?? '' });
    const w = client.open(wallet);
    const balance = await w.getBalance();
    console.log(`network: ${testnet ? 'testnet' : 'MAINNET'}`);
    console.log(`address: ${wallet.address.toString({ testOnly: testnet })}`);
    console.log(`balance: ${Number(balance) / 1e9} TON`);

    const providerM = (process.env.PROVIDER_MNEMONIC ?? '').trim();
    if (providerM) {
        const pkp = await mnemonicToPrivateKey(providerM.split(/\s+/));
        const pw = WalletContractV5R1.create({ publicKey: pkp.publicKey, workchain: 0 });
        const pb = await client.getBalance(pw.address);
        console.log(`provider: ${pw.address.toString({ testOnly: testnet })}`);
        console.log(`provider balance: ${Number(pb) / 1e9} TON`);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
