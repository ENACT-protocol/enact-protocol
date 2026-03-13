import { TonClient, WalletContractV5R1, internal, SendMode, toNano, Cell, contractAddress, beginCell, Address } from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';
import * as fs from 'fs';
import * as path from 'path';

const MNEMONIC = process.env.WALLET_MNEMONIC ?? '';
const ENDPOINT = 'https://toncenter.com/api/v2/jsonRPC';
const API_KEY = process.env.TONCENTER_API_KEY ?? '';

function loadCompiled(name: string): Cell {
    const json = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'build', `${name}.compiled.json`), 'utf-8'));
    return Cell.fromBoc(Buffer.from(json.hex, 'hex'))[0];
}

function buildFactoryData(owner: Address, jobCode: Cell): Cell {
    return beginCell()
        .storeAddress(owner)
        .storeRef(jobCode)
        .storeUint(0, 32)     // nextJobId
        .storeUint(0, 16)     // protocolFeeBps
        .storeAddress(owner)   // feeCollector
        .endCell();
}

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function deploy() {
    console.log('Connecting to TON mainnet...');
    const client = new TonClient({ endpoint: ENDPOINT, apiKey: API_KEY });

    const keyPair = await mnemonicToPrivateKey(MNEMONIC.split(' '));
    const wallet = WalletContractV5R1.create({ publicKey: keyPair.publicKey, workchain: 0 });
    const walletContract = client.open(wallet);

    const balance = await walletContract.getBalance();
    console.log(`Wallet: ${wallet.address.toString()}`);
    console.log(`Balance: ${Number(balance) / 1e9} TON`);

    if (balance < toNano('0.3')) {
        console.error('Not enough TON for deployment. Need at least 0.3 TON.');
        process.exit(1);
    }

    // Load compiled contracts
    const jobCode = loadCompiled('Job');
    const factoryCode = loadCompiled('JobFactory');
    const jettonJobCode = loadCompiled('JettonJob');
    const jettonFactoryCode = loadCompiled('JettonJobFactory');

    // Build JobFactory
    const factoryData = buildFactoryData(wallet.address, jobCode);
    const factoryInit = { code: factoryCode, data: factoryData };
    const factoryAddr = contractAddress(0, factoryInit);

    // Build JettonJobFactory
    const jettonFactoryData = buildFactoryData(wallet.address, jettonJobCode);
    const jettonFactoryInit = { code: jettonFactoryCode, data: jettonFactoryData };
    const jettonFactoryAddr = contractAddress(0, jettonFactoryInit);

    console.log('\n--- Deploying JobFactory ---');
    console.log(`Address: ${factoryAddr.toString()}`);

    let seqno = await walletContract.getSeqno();
    await walletContract.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        sendMode: SendMode.PAY_GAS_SEPARATELY,
        messages: [internal({
            to: factoryAddr,
            value: toNano('0.05'),
            init: factoryInit,
            body: beginCell().endCell(),
            bounce: false,
        })],
    });

    console.log('Waiting for JobFactory deployment...');
    for (let i = 0; i < 30; i++) {
        await sleep(3000);
        const state = await client.getContractState(factoryAddr);
        if (state.state === 'active') {
            console.log('✅ JobFactory deployed!');
            break;
        }
        if (i === 29) {
            console.log('⏳ Timeout waiting for JobFactory. Check tonviewer.com');
        }
    }

    // Wait for seqno to increment
    for (let i = 0; i < 20; i++) {
        await sleep(2000);
        const newSeqno = await walletContract.getSeqno();
        if (newSeqno > seqno) { seqno = newSeqno; break; }
    }

    console.log('\n--- Deploying JettonJobFactory ---');
    console.log(`Address: ${jettonFactoryAddr.toString()}`);

    await walletContract.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        sendMode: SendMode.PAY_GAS_SEPARATELY,
        messages: [internal({
            to: jettonFactoryAddr,
            value: toNano('0.05'),
            init: jettonFactoryInit,
            body: beginCell().endCell(),
            bounce: false,
        })],
    });

    console.log('Waiting for JettonJobFactory deployment...');
    for (let i = 0; i < 30; i++) {
        await sleep(3000);
        const state = await client.getContractState(jettonFactoryAddr);
        if (state.state === 'active') {
            console.log('✅ JettonJobFactory deployed!');
            break;
        }
        if (i === 29) {
            console.log('⏳ Timeout waiting for JettonJobFactory. Check tonviewer.com');
        }
    }

    console.log('\n========================================');
    console.log('DEPLOYMENT COMPLETE');
    console.log('========================================');
    console.log(`JobFactory:       ${factoryAddr.toString()}`);
    console.log(`JettonJobFactory: ${jettonFactoryAddr.toString()}`);
    console.log(`Explorer: https://tonviewer.com/${factoryAddr.toString()}`);
    console.log(`Explorer: https://tonviewer.com/${jettonFactoryAddr.toString()}`);
    console.log('========================================');
}

deploy().catch(e => { console.error(e); process.exit(1); });
