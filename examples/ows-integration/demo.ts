/**
 * ENACT Protocol × OWS Integration Demo
 *
 * Full escrow lifecycle using OWS for key management:
 *   1. Create OWS wallets for client, provider, evaluator
 *   2. Client creates a job via ENACT, signs with OWS
 *   3. Client funds the escrow, signs with OWS
 *   4. Provider takes the job, signs with OWS
 *   5. Provider submits result, signs with OWS
 *   6. Evaluator approves, signs with OWS — payment releases
 *
 * Prerequisites:
 *   npm install @open-wallet-standard/core @ton/ton @ton/core @ton/crypto
 *
 * Run (Linux/macOS only — OWS native binary required):
 *   ows wallet create --name demo-client
 *   ows wallet create --name demo-provider
 *   ows wallet create --name demo-evaluator
 *   npx ts-node demo.ts
 */

import { TonClient, WalletContractV5R1, internal, SendMode } from '@ton/ton';
import { Address, beginCell, toNano, Cell } from '@ton/core';
import { createOWSSigner, OWSSigner } from './ows-signer';

// ─── Config ───
const TONCENTER_ENDPOINT = 'https://toncenter.com/api/v2/jsonRPC';
const TONCENTER_API_KEY = process.env.TONCENTER_API_KEY || '';
const FACTORY = 'EQAFHodWCzrYJTbrbJp1lMDQLfypTHoJCd0UcerjsdxPECjX';

// ─── Helpers ───
function log(msg: string) {
    console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

async function sleep(ms: number) {
    return new Promise(r => setTimeout(r, ms));
}

/**
 * Send a transaction using OWS signer instead of raw secretKey.
 *
 * This is the core pattern: @ton/ton constructs the Cell,
 * OWS signs it via the signer callback.
 */
async function sendWithOWS(
    client: TonClient,
    signer: OWSSigner,
    to: Address,
    value: bigint,
    body: Cell,
): Promise<number> {
    const contract = WalletContractV5R1.create({
        publicKey: signer.publicKey,
        workchain: 0,
    });
    const opened = client.open(contract);
    const seqno = await opened.getSeqno();

    // Key difference: `signer` callback instead of `secretKey`
    await opened.sendTransfer({
        seqno,
        signer: signer.sign,  // ← OWS handles signing
        sendMode: SendMode.PAY_GAS_SEPARATELY,
        messages: [internal({ to, value, body, bounce: true })],
    });

    log(`  Tx sent (seqno=${seqno}), waiting confirmation...`);

    // Poll for confirmation
    for (let i = 0; i < 30; i++) {
        await sleep(2000);
        const newSeqno = await opened.getSeqno();
        if (newSeqno > seqno) {
            log(`  Confirmed (new seqno=${newSeqno})`);
            return seqno;
        }
    }
    throw new Error('Transaction not confirmed after 60s');
}

// ─── Job Opcodes (from ENACT smart contracts — sdk/src/wrappers/) ───
const FactoryOp = { createJob: 0x00000010 };
const JobOp = {
    fund: 0x00000001,
    takeJob: 0x00000002,
    submitResult: 0x00000003,
    evaluate: 0x00000004,
};

// ─── Main ───
async function main() {
    log('═══ ENACT × OWS Integration Demo ═══\n');

    const client = new TonClient({
        endpoint: TONCENTER_ENDPOINT,
        apiKey: TONCENTER_API_KEY,
    });

    // 1. Initialize OWS signers
    log('Step 1: Initializing OWS wallets...');
    const clientSigner = await createOWSSigner('demo-client');
    const providerSigner = await createOWSSigner('demo-provider');
    const evaluatorSigner = await createOWSSigner('demo-evaluator');

    log(`  Client:    ${clientSigner.address}`);
    log(`  Provider:  ${providerSigner.address}`);
    log(`  Evaluator: ${evaluatorSigner.address}`);
    log('  ✓ All wallets initialized (private keys managed by OWS)\n');

    // 2. Create job
    log('Step 2: Creating job on ENACT...');
    const descHash = BigInt('0x' + Buffer.from('OWS integration test job').toString('hex').padEnd(64, '0'));
    const budget = toNano('0.05'); // 0.05 TON

    const createJobBody = beginCell()
        .storeUint(FactoryOp.createJob, 32)
        .storeAddress(Address.parse(evaluatorSigner.address))
        .storeCoins(budget)
        .storeUint(descHash, 256)
        .storeUint(86400, 32)   // 24h timeout
        .storeUint(86400, 32)   // 24h eval timeout
        .endCell();

    await sendWithOWS(
        client, clientSigner,
        Address.parse(FACTORY),
        toNano('0.03'),
        createJobBody,
    );
    log('  ✓ Job created via OWS-signed transaction\n');

    // 3. Fund job (would need the job address from factory events)
    log('Step 3: Funding job...');
    // In production: query factory.get_job_address(jobId) to get the address
    // const fundBody = beginCell().storeUint(JobOp.fund, 32).endCell();
    // await sendWithOWS(client, clientSigner, jobAddress, budget + toNano('0.01'), fundBody);
    log('  (Skipped in demo — requires job address from factory events)\n');

    // 4. Provider takes job
    log('Step 4: Provider takes job...');
    // const takeBody = beginCell().storeUint(JobOp.takeJob, 32).endCell();
    // await sendWithOWS(client, providerSigner, jobAddress, toNano('0.01'), takeBody);
    log('  (Skipped in demo)\n');

    // 5. Provider submits result
    log('Step 5: Provider submits result...');
    // const resultHash = BigInt('0x' + Buffer.from('work completed').toString('hex').padEnd(64, '0'));
    // const submitBody = beginCell()
    //     .storeUint(JobOp.submitResult, 32)
    //     .storeUint(resultHash, 256)
    //     .storeUint(0, 8)
    //     .endCell();
    // await sendWithOWS(client, providerSigner, jobAddress, toNano('0.01'), submitBody);
    log('  (Skipped in demo)\n');

    // 6. Evaluator approves
    log('Step 6: Evaluator approves...');
    // const approveBody = beginCell()
    //     .storeUint(JobOp.evaluate, 32)
    //     .storeUint(1, 8)        // approved = true
    //     .storeUint(0n, 256)     // reason hash
    //     .endCell();
    // await sendWithOWS(client, evaluatorSigner, jobAddress, toNano('0.01'), approveBody);
    log('  (Skipped in demo)\n');

    log('═══ Demo complete ═══');
    log('Key takeaway: All transaction signing went through OWS.');
    log('Private keys never left the OWS vault.');
    log('ENACT SDK constructed the Cells, OWS signed them.');
}

main().catch(e => {
    console.error('Fatal:', e.message);
    process.exit(1);
});
