/**
 * Deploy CodeLibrary on the -1 (masterchain) workchain and register
 * Job + JettonJob bytecodes as public libraries (mode=2). After this
 * script returns the two 32-byte code hashes are visible to every
 * shard; basechain factories can deploy children with a 33-byte
 * library-ref cell instead of the full ~3 KB code.
 *
 * Run: npx ts-node scripts/publish-library.ts
 *
 * Reads WALLET_MNEMONIC + TONCENTER_ENDPOINT from .env.local. Works
 * against both testnet (toncenter-testnet endpoint) and mainnet.
 * Writes deployments/<net>-libraries.json with hashes so the factory
 * deploy can pick them up.
 */
import {
    Address,
    Cell,
    SendMode,
    TonClient,
    WalletContractV5R1,
    beginCell,
    contractAddress,
    internal,
    toNano,
} from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

import { CodeLibrary, codeLibraryConfigToCell } from '../wrappers/CodeLibrary';

dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

const MNEMONIC = (process.env.WALLET_MNEMONIC ?? '').trim();
const API_KEY = process.env.TONCENTER_API_KEY ?? '';
const ENDPOINT =
    process.env.TONCENTER_ENDPOINT ?? 'https://testnet.toncenter.com/api/v2/jsonRPC';
const TESTNET = ENDPOINT.includes('testnet');
const NET_LABEL = TESTNET ? 'testnet' : 'mainnet';
const EXPLORER_HOST = TESTNET ? 'testnet.tonviewer.com' : 'tonviewer.com';
const LIB_FILE = TESTNET ? 'testnet-libraries.json' : 'mainnet-libraries.json';

if (!MNEMONIC) {
    console.error('WALLET_MNEMONIC missing — check .env.local.');
    process.exit(1);
}

function loadCompiled(name: string): Cell {
    const p = path.join(__dirname, '..', 'build', `${name}.compiled.json`);
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return Cell.fromBoc(Buffer.from(j.hex, 'hex'))[0];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function retry<T>(fn: () => Promise<T>, attempts = 6, delay = 3000): Promise<T> {
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

async function waitForSeqno(w: any, expected: number): Promise<number> {
    for (let i = 0; i < 40; i++) {
        await sleep(2500);
        const s: number = await retry(() => w.getSeqno());
        if (s >= expected) return s;
    }
    throw new Error('seqno did not advance');
}

async function waitActive(client: TonClient, addr: Address, label: string) {
    for (let i = 0; i < 40; i++) {
        await sleep(3000);
        const s = await retry(() => client.getContractState(addr));
        if (s.state === 'active') {
            console.log(`  ${label} active after ~${(i + 1) * 3}s`);
            return;
        }
    }
    throw new Error(`${label} did not become active`);
}

async function main() {
    console.log(`--- ENACT v2-lib library publisher (${NET_LABEL}) ---`);
    const client = new TonClient({ endpoint: ENDPOINT, apiKey: API_KEY });
    const kp = await mnemonicToPrivateKey(MNEMONIC.split(/\s+/));

    // Main wallet lives on workchain 0. For masterchain (-1) we use the
    // same key but derive the wallet address at workchain -1.
    const basechainWallet = WalletContractV5R1.create({
        publicKey: kp.publicKey,
        workchain: 0,
    });
    const bw = client.open(basechainWallet);

    const jobLibCode = loadCompiled('Job');
    const jettonJobLibCode = loadCompiled('JettonJob');
    const codeLibCode = loadCompiled('CodeLibrary');

    const jobHash = jobLibCode.hash().toString('hex');
    const jettonHash = jettonJobLibCode.hash().toString('hex');
    console.log(`Job code hash:        ${jobHash}`);
    console.log(`JettonJob code hash:  ${jettonHash}`);

    const publisher = CodeLibrary.createFromConfig(
        { owner: basechainWallet.address },
        codeLibCode,
        -1,
    );
    console.log(`\nPublisher (masterchain): ${publisher.address.toString()}`);

    const balance = await retry(() => bw.getBalance());
    console.log(`wallet (${basechainWallet.address.toString()}): ${Number(balance) / 1e9} TON`);

    // Need ~1.2 TON: 0.15 deploy + 0.5 rent × 2 libraries on masterchain.
    if (balance < toNano('1.2')) {
        console.error(`need at least 1.2 TON; have ${Number(balance) / 1e9}`);
        process.exit(1);
    }

    // Deploy the CodeLibrary on masterchain. value=0.15 TON covers
    // deploy + compute; long-term rent is topped up via the two
    // RegisterLibrary sends below (each carries 0.5 TON).
    const state = await retry(() => client.getContractState(publisher.address));
    let seqno = await retry(() => bw.getSeqno());
    if (state.state !== 'active') {
        console.log('\n--- Deploying CodeLibrary on masterchain ---');
        await retry(() =>
            bw.sendTransfer({
                seqno,
                secretKey: kp.secretKey,
                sendMode: SendMode.PAY_GAS_SEPARATELY,
                messages: [
                    internal({
                        to: publisher.address,
                        value: toNano('0.15'),
                        init: { code: codeLibCode, data: codeLibraryConfigToCell({ owner: basechainWallet.address }) },
                        body: beginCell().endCell(),
                        bounce: false,
                    }),
                ],
            }),
        );
        await waitActive(client, publisher.address, 'CodeLibrary');
        seqno = await waitForSeqno(bw, seqno + 1);
    } else {
        console.log('CodeLibrary already active, skipping deploy');
    }

    // Register each library. 0.5 TON pre-pays long-term rent on masterchain.
    async function sendRegister(libCode: Cell, label: string) {
        console.log(`\n--- RegisterLibrary: ${label} ---`);
        const body = beginCell()
            .storeUint(0x9c6a0ee4, 32)
            .storeUint(2, 8)            // mode = PUBLIC
            .storeRef(libCode)
            .endCell();
        await retry(() =>
            bw.sendTransfer({
                seqno,
                secretKey: kp.secretKey,
                sendMode: SendMode.PAY_GAS_SEPARATELY,
                messages: [
                    internal({
                        to: publisher.address,
                        value: toNano('0.5'),
                        body,
                        bounce: true,
                    }),
                ],
            }),
        );
        seqno = await waitForSeqno(bw, seqno + 1);
        console.log(`  ${label} register tx sent, seqno ${seqno}`);
    }

    await sendRegister(jobLibCode, 'Job');
    await sendRegister(jettonJobLibCode, 'JettonJob');

    // Persist hashes for the factory deploy to consume.
    const outPath = path.join(__dirname, '..', 'deployments', LIB_FILE);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(
        outPath,
        JSON.stringify(
            {
                network: NET_LABEL,
                publishedAt: new Date().toISOString(),
                publisher: publisher.address.toString(),
                libraries: {
                    job: { hash: jobHash },
                    jettonJob: { hash: jettonHash },
                },
                explorer: {
                    publisher: `https://${EXPLORER_HOST}/${publisher.address.toString()}`,
                },
            },
            null,
            2,
        ) + '\n',
    );

    console.log('\n===== LIBRARY PUBLISHED =====');
    console.log(`publisher: ${publisher.address.toString()}`);
    console.log(`Job hash:        ${jobHash}`);
    console.log(`JettonJob hash:  ${jettonHash}`);
    console.log(`saved: ${path.relative(process.cwd(), outPath)}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
