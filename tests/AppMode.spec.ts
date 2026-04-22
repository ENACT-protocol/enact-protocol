import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, Cell, toNano } from '@ton/core';
import { KeyPair, keyPairFromSeed } from '@ton/crypto';
import { Job, JobMode, signBid } from '../wrappers/Job';
import { JobFactory } from '../wrappers/JobFactory';
import { JettonJob } from '../wrappers/JettonJob';
import { JettonJobFactory } from '../wrappers/JettonJobFactory';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { randomBytes } from 'crypto';

// v2 AppMode: client posts a job in MODE_APPLICATION, providers sign
// off-chain bids, client picks a winner via AcceptProvider. The ed25519
// signature covers (jobAddr, proposedBudget, providerAddr).

describe('AppMode', () => {
    let jobCode: Cell;
    let factoryCode: Cell;
    let jettonJobCode: Cell;
    let jettonFactoryCode: Cell;

    beforeAll(async () => {
        jobCode = await compile('Job');
        factoryCode = await compile('JobFactory');
        jettonJobCode = await compile('JettonJob');
        jettonFactoryCode = await compile('JettonJobFactory');
    }, 30000);

    let blockchain: Blockchain;
    let client: SandboxContract<TreasuryContract>;
    let evaluator: SandboxContract<TreasuryContract>;
    let outsider: SandboxContract<TreasuryContract>;
    let jettonWalletTreasury: SandboxContract<TreasuryContract>;

    const TIMEOUT = 86400;
    const EVAL_TIMEOUT = 86400;
    const APP_WINDOW = 86400;
    const DESC_HASH = BigInt('0x' + 'a'.repeat(64));
    const BUDGET = toNano('5');

    function newKeypair(): KeyPair {
        return keyPairFromSeed(randomBytes(32));
    }

    // Provider addresses are arbitrary in these tests — the signature
    // covers the pubkey, and the contract trusts the client to supply a
    // matching (pubkey, providerAddress) tuple. See wrappers/Job.ts
    // signBid() for the canonical signing payload.
    function newProviderAddress(): Address {
        return new Address(0, randomBytes(32));
    }

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        client = await blockchain.treasury('client');
        evaluator = await blockchain.treasury('evaluator');
        outsider = await blockchain.treasury('outsider');
        jettonWalletTreasury = await blockchain.treasury('jw');
    });

    async function deployAppJob(budget: bigint = BUDGET) {
        const factory = blockchain.openContract(
            JobFactory.createFromConfig({ owner: client.address, jobCode }, factoryCode),
        );
        await factory.sendDeploy(client.getSender(), toNano('0.1'));
        await factory.sendCreateJob(client.getSender(), toNano('0.1'), {
            evaluatorAddress: evaluator.address,
            budget,
            descriptionHash: DESC_HASH,
            timeout: TIMEOUT,
            evaluationTimeout: EVAL_TIMEOUT,
            mode: JobMode.APPLICATION,
            applicationWindow: APP_WINDOW,
        });
        const addr = await factory.getJobAddress(0);
        const job = blockchain.openContract(Job.createFromAddress(addr));
        await job.sendFund(client.getSender(), budget + toNano('0.1'));
        return job;
    }

    async function deployFixedJob() {
        const factory = blockchain.openContract(
            JobFactory.createFromConfig({ owner: client.address, jobCode }, factoryCode),
        );
        await factory.sendDeploy(client.getSender(), toNano('0.1'));
        await factory.sendCreateJob(client.getSender(), toNano('0.1'), {
            evaluatorAddress: evaluator.address,
            budget: BUDGET,
            descriptionHash: DESC_HASH,
            timeout: TIMEOUT,
            evaluationTimeout: EVAL_TIMEOUT,
        });
        const addr = await factory.getJobAddress(0);
        const job = blockchain.openContract(Job.createFromAddress(addr));
        await job.sendFund(client.getSender(), BUDGET + toNano('0.1'));
        return job;
    }

    it('factory rejects APPLICATION with window below MIN_APP_WINDOW', async () => {
        const factory = blockchain.openContract(
            JobFactory.createFromConfig({ owner: client.address, jobCode }, factoryCode),
        );
        await factory.sendDeploy(client.getSender(), toNano('0.1'));
        const res = await factory.sendCreateJob(client.getSender(), toNano('0.1'), {
            evaluatorAddress: evaluator.address,
            budget: BUDGET,
            descriptionHash: DESC_HASH,
            timeout: TIMEOUT,
            evaluationTimeout: EVAL_TIMEOUT,
            mode: JobMode.APPLICATION,
            applicationWindow: 60,
        });
        expect(res.transactions).toHaveTransaction({
            from: client.address,
            to: factory.address,
            success: false,
            exitCode: 202, // ERR_INVALID_TIMEOUT
        });
    });

    it('TON AppMode: get_v2_data reports mode + deadline after deploy', async () => {
        const job = await deployAppJob();
        const v2 = await job.getV2Data();
        expect(v2.mode).toBe(JobMode.APPLICATION);
        expect(v2.applicationDeadline).toBeGreaterThan(0);
    });

    it('TON AppMode: TakeJob is blocked (wrong mode)', async () => {
        const job = await deployAppJob();
        const racer = await blockchain.treasury('racer');
        const res = await job.sendTakeJob(racer.getSender(), toNano('0.05'));
        expect(res.transactions).toHaveTransaction({
            from: racer.address,
            to: job.address,
            success: false,
            exitCode: 112, // ERR_WRONG_MODE
        });
    });

    it('TON AppMode: AcceptProvider with valid signature assigns provider', async () => {
        const job = await deployAppJob();
        const kp = newKeypair();
        const providerAddr = newProviderAddress();
        const signature = signBid(
            { jobAddress: job.address, proposedBudget: BUDGET, providerAddress: providerAddr },
            kp.secretKey,
        );

        const res = await job.sendAcceptProvider(client.getSender(), toNano('0.1'), {
            providerAddress: providerAddr,
            proposedBudget: BUDGET,
            providerPubkey: kp.publicKey,
            signature,
        });
        expect(res.transactions).toHaveTransaction({
            from: client.address,
            to: job.address,
            success: true,
        });

        const data = await job.getJobData();
        expect(data.providerAddress?.equals(providerAddr)).toBe(true);
        expect(data.state).toBe(1); // FUNDED, provider assigned
    });

    it('TON AppMode: AcceptProvider with bad signature rejected', async () => {
        const job = await deployAppJob();
        const kp = newKeypair();
        const providerAddr = newProviderAddress();
        const badKp = newKeypair();
        // Signature made by a different key than the pubkey submitted.
        const badSig = signBid(
            { jobAddress: job.address, proposedBudget: BUDGET, providerAddress: providerAddr },
            badKp.secretKey,
        );

        const res = await job.sendAcceptProvider(client.getSender(), toNano('0.1'), {
            providerAddress: providerAddr,
            proposedBudget: BUDGET,
            providerPubkey: kp.publicKey,
            signature: badSig,
        });
        expect(res.transactions).toHaveTransaction({
            from: client.address,
            to: job.address,
            success: false,
            exitCode: 114, // ERR_BAD_SIGNATURE
        });
    });

    it('TON AppMode: AcceptProvider rejects a bid for a different budget', async () => {
        const job = await deployAppJob();
        const kp = newKeypair();
        const providerAddr = newProviderAddress();
        // Provider signed for 4 TON, client tries to submit at BUDGET=5 TON.
        const signedFor = toNano('4');
        const signature = signBid(
            { jobAddress: job.address, proposedBudget: signedFor, providerAddress: providerAddr },
            kp.secretKey,
        );

        const res = await job.sendAcceptProvider(client.getSender(), toNano('0.1'), {
            providerAddress: providerAddr,
            proposedBudget: BUDGET,
            providerPubkey: kp.publicKey,
            signature,
        });
        expect(res.transactions).toHaveTransaction({
            from: client.address,
            to: job.address,
            success: false,
            exitCode: 114, // ERR_BAD_SIGNATURE
        });
    });

    it('TON AppMode: AcceptProvider rejects evaluator as provider', async () => {
        const job = await deployAppJob();
        const kp = newKeypair();
        const evalAddr = evaluator.address; // evaluator cannot take their own job
        const signature = signBid(
            { jobAddress: job.address, proposedBudget: BUDGET, providerAddress: evalAddr },
            kp.secretKey,
        );

        const res = await job.sendAcceptProvider(client.getSender(), toNano('0.1'), {
            providerAddress: evalAddr,
            proposedBudget: BUDGET,
            providerPubkey: kp.publicKey,
            signature,
        });
        expect(res.transactions).toHaveTransaction({
            from: client.address,
            to: job.address,
            success: false,
            exitCode: 100, // ERR_ACCESS_DENIED
        });
    });

    it('TON AppMode: non-client cannot AcceptProvider', async () => {
        const job = await deployAppJob();
        const kp = newKeypair();
        const providerAddr = newProviderAddress();
        const signature = signBid(
            { jobAddress: job.address, proposedBudget: BUDGET, providerAddress: providerAddr },
            kp.secretKey,
        );
        const res = await job.sendAcceptProvider(outsider.getSender(), toNano('0.1'), {
            providerAddress: providerAddr,
            proposedBudget: BUDGET,
            providerPubkey: kp.publicKey,
            signature,
        });
        expect(res.transactions).toHaveTransaction({
            from: outsider.address,
            to: job.address,
            success: false,
            exitCode: 100, // ERR_ACCESS_DENIED
        });
    });

    it('TON AppMode: AcceptProvider rejected after deadline', async () => {
        const job = await deployAppJob();
        const v2 = await job.getV2Data();
        blockchain.now = v2.applicationDeadline + 10;

        const kp = newKeypair();
        const providerAddr = newProviderAddress();
        const signature = signBid(
            { jobAddress: job.address, proposedBudget: BUDGET, providerAddress: providerAddr },
            kp.secretKey,
        );
        const res = await job.sendAcceptProvider(client.getSender(), toNano('0.1'), {
            providerAddress: providerAddr,
            proposedBudget: BUDGET,
            providerPubkey: kp.publicKey,
            signature,
        });
        expect(res.transactions).toHaveTransaction({
            from: client.address,
            to: job.address,
            success: false,
            exitCode: 113, // ERR_APP_WINDOW_EXPIRED
        });
    });

    it('TON AppMode: ExtendWindow pushes the deadline', async () => {
        const job = await deployAppJob();
        const before = (await job.getV2Data()).applicationDeadline;
        const next = before + 3600;
        await job.sendExtendWindow(client.getSender(), toNano('0.05'), next);
        const after = (await job.getV2Data()).applicationDeadline;
        expect(after).toBe(next);
    });

    it('TON AppMode: ExtendWindow rejects non-monotonic deadline', async () => {
        const job = await deployAppJob();
        const before = (await job.getV2Data()).applicationDeadline;
        const res = await job.sendExtendWindow(client.getSender(), toNano('0.05'), before);
        expect(res.transactions).toHaveTransaction({
            from: client.address,
            to: job.address,
            success: false,
            exitCode: 113, // ERR_APP_WINDOW_EXPIRED
        });
    });

    it('TON FIXED: AcceptProvider rejected (wrong mode)', async () => {
        const job = await deployFixedJob();
        const kp = newKeypair();
        const providerAddr = newProviderAddress();
        const signature = signBid(
            { jobAddress: job.address, proposedBudget: BUDGET, providerAddress: providerAddr },
            kp.secretKey,
        );
        const res = await job.sendAcceptProvider(client.getSender(), toNano('0.1'), {
            providerAddress: providerAddr,
            proposedBudget: BUDGET,
            providerPubkey: kp.publicKey,
            signature,
        });
        expect(res.transactions).toHaveTransaction({
            from: client.address,
            to: job.address,
            success: false,
            exitCode: 112, // ERR_WRONG_MODE
        });
    });

    // ========== Jetton AppMode ==========

    it('Jetton AppMode: AcceptProvider with valid signature', async () => {
        const factory = blockchain.openContract(
            JettonJobFactory.createFromConfig({ owner: client.address, jobCode: jettonJobCode }, jettonFactoryCode),
        );
        await factory.sendDeploy(client.getSender(), toNano('0.1'));
        const budget = 1000n;
        await factory.sendCreateJob(client.getSender(), toNano('0.1'), {
            evaluatorAddress: evaluator.address,
            budget,
            descriptionHash: DESC_HASH,
            timeout: TIMEOUT,
            evaluationTimeout: EVAL_TIMEOUT,
            mode: JobMode.APPLICATION,
            applicationWindow: APP_WINDOW,
        });
        const addr = await factory.getJobAddress(0);
        const job = blockchain.openContract(JettonJob.createFromAddress(addr));
        await job.sendSetJettonWallet(client.getSender(), toNano('0.05'), jettonWalletTreasury.address);
        await job.sendTransferNotification(jettonWalletTreasury.getSender(), toNano('0.1'), {
            amount: budget,
            sender: client.address,
        });
        expect(await job.getState()).toBe(1);

        const kp = newKeypair();
        const providerAddr = newProviderAddress();
        const signature = signBid(
            { jobAddress: job.address, proposedBudget: budget, providerAddress: providerAddr },
            kp.secretKey,
        );
        const res = await job.sendAcceptProvider(client.getSender(), toNano('0.1'), {
            providerAddress: providerAddr,
            proposedBudget: budget,
            providerPubkey: kp.publicKey,
            signature,
        });
        expect(res.transactions).toHaveTransaction({
            from: client.address,
            to: job.address,
            success: true,
        });

        const data = await job.getJobData();
        expect(data.providerAddress?.equals(providerAddr)).toBe(true);
    });
});
