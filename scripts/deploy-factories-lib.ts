/**
 * Deploy v2-lib factories (JobFactoryLib + JettonJobFactoryLib) on the
 * basechain using the library hashes from deployments/<net>-libraries.json.
 *
 * Run: npx ts-node scripts/deploy-factories-lib.ts
 *
 * Writes deployments/<net>-v2-lib.json so the e2e scripts (with
 * DEPLOY_LABEL=lib) can pick up the new factory addresses.
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

dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

const MNEMONIC = (process.env.WALLET_MNEMONIC ?? '').trim();
const API_KEY = process.env.TONCENTER_API_KEY ?? '';
const ENDPOINT =
    process.env.TONCENTER_ENDPOINT ?? 'https://testnet.toncenter.com/api/v2/jsonRPC';
const TESTNET = ENDPOINT.includes('testnet');
const NET_LABEL = TESTNET ? 'testnet' : 'mainnet';
const EXPLORER_HOST = TESTNET ? 'testnet.tonviewer.com' : 'tonviewer.com';

if (!MNEMONIC) {
    console.error('WALLET_MNEMONIC missing — check .env.local.');
    process.exit(1);
}

function loadCompiled(name: string): Cell {
    const p = path.join(__dirname, '..', 'build', `${name}.compiled.json`);
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return Cell.fromBoc(Buffer.from(j.hex, 'hex'))[0];
}

function buildFactoryLibData(owner: Address, jobCodeHash: Buffer): Cell {
    if (jobCodeHash.length !== 32) throw new Error('jobCodeHash must be 32 bytes');
    return beginCell().storeAddress(owner).storeBuffer(jobCodeHash).storeUint(0, 32).endCell();
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
    console.log(`--- ENACT v2-lib factory deploy (${NET_LABEL}) ---`);
    const libs = JSON.parse(
        fs.readFileSync(
            path.join(__dirname, '..', 'deployments', TESTNET ? 'testnet-libraries.json' : 'mainnet-libraries.json'),
            'utf-8',
        ),
    );
    const jobHash = Buffer.from(libs.libraries.job.hash, 'hex');
    const jettonHash = Buffer.from(libs.libraries.jettonJob.hash, 'hex');

    const client = new TonClient({ endpoint: ENDPOINT, apiKey: API_KEY });
    const kp = await mnemonicToPrivateKey(MNEMONIC.split(/\s+/));
    const wallet = WalletContractV5R1.create({ publicKey: kp.publicKey, workchain: 0 });
    const w = client.open(wallet);

    const factoryCode = loadCompiled('JobFactoryLib');
    const jFactoryCode = loadCompiled('JettonJobFactoryLib');

    const factoryInit = {
        code: factoryCode,
        data: buildFactoryLibData(wallet.address, jobHash),
    };
    const jFactoryInit = {
        code: jFactoryCode,
        data: buildFactoryLibData(wallet.address, jettonHash),
    };
    const factoryAddr = contractAddress(0, factoryInit);
    const jFactoryAddr = contractAddress(0, jFactoryInit);

    console.log(`\nJobFactoryLib:       ${factoryAddr.toString({ testOnly: TESTNET })}`);
    console.log(`JettonJobFactoryLib: ${jFactoryAddr.toString({ testOnly: TESTNET })}`);

    const balance = await retry(() => w.getBalance());
    console.log(`wallet: ${wallet.address.toString({ testOnly: TESTNET })} — ${Number(balance) / 1e9} TON`);
    if (balance < toNano('0.25')) {
        console.error('need at least 0.25 TON on deploy wallet');
        process.exit(1);
    }

    let seqno = await retry(() => w.getSeqno());

    console.log('\n--- Deploying JobFactoryLib ---');
    await retry(() =>
        w.sendTransfer({
            seqno,
            secretKey: kp.secretKey,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            messages: [
                internal({
                    to: factoryAddr,
                    value: toNano('0.08'),
                    init: factoryInit,
                    body: beginCell().endCell(),
                    bounce: false,
                }),
            ],
        }),
    );
    await waitActive(client, factoryAddr, 'JobFactoryLib');
    seqno = await waitForSeqno(w, seqno + 1);

    console.log('\n--- Deploying JettonJobFactoryLib ---');
    await retry(() =>
        w.sendTransfer({
            seqno,
            secretKey: kp.secretKey,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            messages: [
                internal({
                    to: jFactoryAddr,
                    value: toNano('0.08'),
                    init: jFactoryInit,
                    body: beginCell().endCell(),
                    bounce: false,
                }),
            ],
        }),
    );
    await waitActive(client, jFactoryAddr, 'JettonJobFactoryLib');

    const record = {
        network: NET_LABEL,
        deployedAt: new Date().toISOString(),
        wallet: wallet.address.toString({ testOnly: TESTNET }),
        factory: {
            address: factoryAddr.toString({ testOnly: TESTNET }),
            rawAddress: factoryAddr.toRawString(),
        },
        jettonFactory: {
            address: jFactoryAddr.toString({ testOnly: TESTNET }),
            rawAddress: jFactoryAddr.toRawString(),
        },
        libraries: libs.libraries,
        versions: { factory: 4, jettonFactory: 4, variant: 'v2-lib' },
        explorer: {
            factory: `https://${EXPLORER_HOST}/${factoryAddr.toString({ testOnly: TESTNET })}`,
            jettonFactory: `https://${EXPLORER_HOST}/${jFactoryAddr.toString({ testOnly: TESTNET })}`,
        },
    };
    const outPath = path.join(
        __dirname,
        '..',
        'deployments',
        TESTNET ? 'testnet-v2-lib.json' : 'mainnet-v2-lib.json',
    );
    fs.writeFileSync(outPath, JSON.stringify(record, null, 2) + '\n');

    console.log('\n===== v2-lib DEPLOY COMPLETE =====');
    console.log(`JobFactoryLib:       ${record.factory.address}`);
    console.log(`JettonJobFactoryLib: ${record.jettonFactory.address}`);
    console.log(`saved: ${path.relative(process.cwd(), outPath)}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
