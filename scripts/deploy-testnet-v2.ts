/**
 * Deploy ENACT v2 factories (JobFactory v4 + JettonJobFactory v4) to TON
 * testnet. Reads WALLET_MNEMONIC from .env.local, never from the repo.
 *
 * Run: npx ts-node scripts/deploy-testnet-v2.ts
 *
 * Writes addresses + deploy-tx info to deployments/testnet-v2.json so the
 * e2e script can pick them up without re-deriving.
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
// Opt in to a dedicated deployment record for the v2-opt (post-OPT-2/O-4/O-8)
// bytecode so the pre-opt v4 deployments stay captured for reference.
const OPT_SUFFIX = (process.env.DEPLOY_LABEL ?? '').length > 0 ? `-${process.env.DEPLOY_LABEL}` : '';
const DEPLOY_FILE = TESTNET ? `testnet-v2${OPT_SUFFIX}.json` : `mainnet-v2${OPT_SUFFIX}.json`;

if (!MNEMONIC) {
    console.error('WALLET_MNEMONIC missing. Create .env.local from .env.local.example.');
    process.exit(1);
}

function loadCompiled(name: string): Cell {
    const p = path.join(__dirname, '..', 'build', `${name}.compiled.json`);
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return Cell.fromBoc(Buffer.from(j.hex, 'hex'))[0];
}

// v4 factory storage: owner + jobCode + nextJobId:uint32. No dead fee fields.
function buildFactoryData(owner: Address, jobCode: Cell): Cell {
    return beginCell().storeAddress(owner).storeRef(jobCode).storeUint(0, 32).endCell();
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

async function waitActive(client: TonClient, addr: Address, label: string) {
    for (let i = 0; i < 40; i++) {
        await sleep(3000);
        const state = await retry(() => client.getContractState(addr));
        if (state.state === 'active') {
            console.log(`  ${label} active after ~${(i + 1) * 3}s`);
            return;
        }
    }
    throw new Error(`${label} did not become active`);
}

async function waitForSeqno(wallet: any, expected: number): Promise<number> {
    for (let i = 0; i < 30; i++) {
        await sleep(2000);
        const s: number = await retry(() => wallet.getSeqno());
        if (s >= expected) return s;
    }
    throw new Error('seqno did not advance');
}

async function main() {
    console.log(`--- ENACT v2 ${NET_LABEL} deploy ---`);
    console.log(`endpoint: ${ENDPOINT}`);
    const client = new TonClient({ endpoint: ENDPOINT, apiKey: API_KEY });
    const kp = await mnemonicToPrivateKey(MNEMONIC.split(/\s+/));
    const wallet = WalletContractV5R1.create({ publicKey: kp.publicKey, workchain: 0 });
    const w = client.open(wallet);

    const balance = await retry(() => w.getBalance());
    console.log(`wallet: ${wallet.address.toString({ testOnly: TESTNET })}`);
    console.log(`balance: ${Number(balance) / 1e9} TON`);
    if (balance < toNano('0.5')) {
        console.error('need at least 0.5 TON for the two deploys. top up via https://t.me/testgiver_ton_bot');
        process.exit(1);
    }

    const jobCode = loadCompiled('Job');
    const factoryCode = loadCompiled('JobFactory');
    const jettonJobCode = loadCompiled('JettonJob');
    const jettonFactoryCode = loadCompiled('JettonJobFactory');

    const factoryData = buildFactoryData(wallet.address, jobCode);
    const factoryInit = { code: factoryCode, data: factoryData };
    const factoryAddr = contractAddress(0, factoryInit);

    const jFactoryData = buildFactoryData(wallet.address, jettonJobCode);
    const jFactoryInit = { code: jettonFactoryCode, data: jFactoryData };
    const jFactoryAddr = contractAddress(0, jFactoryInit);

    console.log('\n--- JobFactory v4 ---');
    console.log(`address: ${factoryAddr.toString({ testOnly: TESTNET })}`);

    let seqno = await retry(() => w.getSeqno());
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
    await waitActive(client, factoryAddr, 'JobFactory');
    seqno = await waitForSeqno(w, seqno + 1);

    console.log('\n--- JettonJobFactory v4 ---');
    console.log(`address: ${jFactoryAddr.toString({ testOnly: TESTNET })}`);

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
    await waitActive(client, jFactoryAddr, 'JettonJobFactory');

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
        versions: { factory: 4, jettonFactory: 4 },
        explorer: {
            factory: `https://${EXPLORER_HOST}/${factoryAddr.toString({ testOnly: TESTNET })}`,
            jettonFactory: `https://${EXPLORER_HOST}/${jFactoryAddr.toString({ testOnly: TESTNET })}`,
        },
    };
    const outPath = path.join(__dirname, '..', 'deployments', DEPLOY_FILE);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(record, null, 2) + '\n');

    console.log('\n===== DEPLOY COMPLETE =====');
    console.log(`JobFactory:       ${record.factory.address}`);
    console.log(`JettonJobFactory: ${record.jettonFactory.address}`);
    console.log(`saved: ${path.relative(process.cwd(), outPath)}`);
    console.log(`explorer: ${record.explorer.factory}`);
    console.log(`explorer: ${record.explorer.jettonFactory}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
