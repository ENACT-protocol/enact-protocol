import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, toNano } from '@ton/core';
import { Job } from '../wrappers/Job';
import { JobFactory } from '../wrappers/JobFactory';
import { JettonJob } from '../wrappers/JettonJob';
import { JettonJobFactory } from '../wrappers/JettonJobFactory';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';

// v2: SetBudget is allowed in FUNDED as an increase-only top-up.
// TON jobs top up atomically (delta delivered via msg.value); jetton
// jobs stage a pendingBudget and accept the delta via a follow-up
// TransferNotification.

describe('SetBudget+ (FUNDED top-up)', () => {
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
    const DESC_HASH = BigInt('0x' + 'a'.repeat(64));

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        client = await blockchain.treasury('client');
        evaluator = await blockchain.treasury('evaluator');
        outsider = await blockchain.treasury('outsider');
        jettonWalletTreasury = await blockchain.treasury('jw');
    });

    async function deployTonJob(budget: bigint) {
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
        });
        const addr = await factory.getJobAddress(0);
        return blockchain.openContract(Job.createFromAddress(addr));
    }

    async function deployFundedJettonJob(budget: bigint) {
        const factory = blockchain.openContract(
            JettonJobFactory.createFromConfig({ owner: client.address, jobCode: jettonJobCode }, jettonFactoryCode),
        );
        await factory.sendDeploy(client.getSender(), toNano('0.1'));
        await factory.sendCreateJob(client.getSender(), toNano('0.1'), {
            evaluatorAddress: evaluator.address,
            budget,
            descriptionHash: DESC_HASH,
            timeout: TIMEOUT,
            evaluationTimeout: EVAL_TIMEOUT,
        });
        const addr = await factory.getJobAddress(0);
        const job = blockchain.openContract(JettonJob.createFromAddress(addr));
        await job.sendSetJettonWallet(client.getSender(), toNano('0.05'), jettonWalletTreasury.address);
        await job.sendTransferNotification(jettonWalletTreasury.getSender(), toNano('0.1'), {
            amount: budget,
            sender: client.address,
        });
        return job;
    }

    // ========== TON ==========

    it('TON: increase budget in FUNDED with delta + gas', async () => {
        const initial = toNano('3');
        const target = toNano('7');
        const delta = target - initial;

        const job = await deployTonJob(initial);
        await job.sendFund(client.getSender(), initial + toNano('0.1'));
        expect(await job.getState()).toBe(1);

        const res = await job.sendSetBudget(client.getSender(), delta + toNano('0.1'), target);
        expect(res.transactions).toHaveTransaction({
            from: client.address,
            to: job.address,
            success: true,
        });

        const data = await job.getJobData();
        expect(data.budget).toBe(target);
        expect(data.state).toBe(1); // still FUNDED
    });

    it('TON: reject top-up when value does not cover delta', async () => {
        const initial = toNano('3');
        const target = toNano('7');

        const job = await deployTonJob(initial);
        await job.sendFund(client.getSender(), initial + toNano('0.1'));

        // 0.05 TON cannot cover the 4-TON delta.
        const res = await job.sendSetBudget(client.getSender(), toNano('0.05'), target);
        expect(res.transactions).toHaveTransaction({
            from: client.address,
            to: job.address,
            success: false,
            exitCode: 104, // ERR_INSUFFICIENT_FUNDS
        });

        const data = await job.getJobData();
        expect(data.budget).toBe(initial); // unchanged
    });

    it('TON: reject decrease in FUNDED', async () => {
        const initial = toNano('5');
        const job = await deployTonJob(initial);
        await job.sendFund(client.getSender(), initial + toNano('0.1'));

        const res = await job.sendSetBudget(client.getSender(), toNano('0.05'), toNano('3'));
        expect(res.transactions).toHaveTransaction({
            from: client.address,
            to: job.address,
            success: false,
            exitCode: 115, // ERR_BUDGET_DECREASE
        });
    });

    it('TON: reject from non-client', async () => {
        const job = await deployTonJob(toNano('3'));
        await job.sendFund(client.getSender(), toNano('3') + toNano('0.1'));
        const res = await job.sendSetBudget(outsider.getSender(), toNano('5'), toNano('7'));
        expect(res.transactions).toHaveTransaction({
            from: outsider.address,
            to: job.address,
            success: false,
            exitCode: 100, // ERR_ACCESS_DENIED
        });
    });

    // ========== Jetton ==========

    it('Jetton: SetBudget stages pendingBudget, TransferNotification promotes', async () => {
        const initial = 1000n;
        const target = 2500n;
        const delta = target - initial;

        const job = await deployFundedJettonJob(initial);
        expect((await job.getJobData()).budget).toBe(initial);

        // Stage the top-up.
        await job.sendSetBudget(client.getSender(), toNano('0.1'), target);
        const staged = await job.getV2Data();
        expect(staged.pendingBudget).toBe(target);
        expect((await job.getJobData()).budget).toBe(initial); // not yet promoted

        // Deliver the delta via the jetton wallet.
        await job.sendTransferNotification(jettonWalletTreasury.getSender(), toNano('0.1'), {
            amount: delta,
            sender: client.address,
        });

        const promoted = await job.getV2Data();
        expect(promoted.pendingBudget).toBe(0n);
        expect((await job.getJobData()).budget).toBe(target);
        expect(await job.getState()).toBe(1);
    });

    it('Jetton: reject SetBudget decrease in FUNDED', async () => {
        const job = await deployFundedJettonJob(5000n);
        const res = await job.sendSetBudget(client.getSender(), toNano('0.05'), 3000n);
        expect(res.transactions).toHaveTransaction({
            from: client.address,
            to: job.address,
            success: false,
            exitCode: 115, // ERR_BUDGET_DECREASE
        });
    });

    it('Jetton: reject TransferNotification delta mismatch', async () => {
        const initial = 1000n;
        const target = 2500n;
        const job = await deployFundedJettonJob(initial);
        await job.sendSetBudget(client.getSender(), toNano('0.1'), target);

        // Correct delta = 1500. Send 1000 instead.
        const res = await job.sendTransferNotification(jettonWalletTreasury.getSender(), toNano('0.1'), {
            amount: 1000n,
            sender: client.address,
        });
        expect(res.transactions).toHaveTransaction({
            from: jettonWalletTreasury.address,
            to: job.address,
            success: false,
            exitCode: 104, // ERR_INSUFFICIENT_FUNDS
        });
        expect((await job.getJobData()).budget).toBe(initial); // unchanged
    });

    it('Jetton: reject stray TransferNotification in FUNDED when no pending', async () => {
        const job = await deployFundedJettonJob(1000n);
        // pendingBudget is 0, a transfer has nothing to settle.
        const res = await job.sendTransferNotification(jettonWalletTreasury.getSender(), toNano('0.1'), {
            amount: 500n,
            sender: client.address,
        });
        expect(res.transactions).toHaveTransaction({
            from: jettonWalletTreasury.address,
            to: job.address,
            success: false,
            exitCode: 101, // ERR_INVALID_STATE
        });
    });
});
