import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, toNano, Address } from '@ton/core';
import { Job, JobOpcodes } from '../wrappers/Job';
import { JobFactory } from '../wrappers/JobFactory';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';

describe('Job', () => {
    let jobCode: Cell;
    let factoryCode: Cell;

    beforeAll(async () => {
        jobCode = await compile('Job');
        factoryCode = await compile('JobFactory');
    }, 30000);

    let blockchain: Blockchain;
    let factory: SandboxContract<JobFactory>;
    let client: SandboxContract<TreasuryContract>;
    let provider: SandboxContract<TreasuryContract>;
    let evaluator: SandboxContract<TreasuryContract>;
    let outsider: SandboxContract<TreasuryContract>;

    const TIMEOUT = 86400; // 24h
    const EVAL_TIMEOUT = 86400; // 24h
    const BUDGET = toNano('5');
    const DESC_HASH = BigInt('0x' + 'a'.repeat(64));
    const RESULT_HASH = BigInt('0x' + 'b'.repeat(64));
    const REASON_HASH = BigInt('0x' + 'c'.repeat(64));

    async function deployFactoryAndCreateJob(evalAddr?: Address, budget?: bigint) {
        factory = blockchain.openContract(
            JobFactory.createFromConfig(
                { owner: client.address, jobCode },
                factoryCode
            )
        );

        await factory.sendDeploy(client.getSender(), toNano('0.1'));

        const evalAddress = evalAddr ?? evaluator.address;

        await factory.sendCreateJob(client.getSender(), toNano('0.1'), {
            evaluatorAddress: evalAddress,
            budget: budget ?? BUDGET,
            descriptionHash: DESC_HASH,
            timeout: TIMEOUT,
            evaluationTimeout: EVAL_TIMEOUT,
        });

        const jobAddress = await factory.getJobAddress(0);
        return blockchain.openContract(Job.createFromAddress(jobAddress));
    }

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        client = await blockchain.treasury('client');
        provider = await blockchain.treasury('provider');
        evaluator = await blockchain.treasury('evaluator');
        outsider = await blockchain.treasury('outsider');
    });

    // ========== HAPPY PATH ==========

    it('happy path: create → fund → take → submit → approve → completed', async () => {
        const job = await deployFactoryAndCreateJob();

        // Fund
        const fundResult = await job.sendFund(client.getSender(), BUDGET + toNano('0.1'));
        expect(fundResult.transactions).toHaveTransaction({
            from: client.address,
            to: job.address,
            success: true,
        });
        expect(await job.getState()).toBe(1); // FUNDED

        // Take
        const takeResult = await job.sendTakeJob(provider.getSender(), toNano('0.05'));
        expect(takeResult.transactions).toHaveTransaction({
            from: provider.address,
            to: job.address,
            success: true,
        });

        // Submit
        const submitResult = await job.sendSubmitResult(provider.getSender(), toNano('0.05'), RESULT_HASH);
        expect(submitResult.transactions).toHaveTransaction({
            from: provider.address,
            to: job.address,
            success: true,
        });
        expect(await job.getState()).toBe(2); // SUBMITTED

        // Evaluate — approve
        const evalResult = await job.sendEvaluate(evaluator.getSender(), toNano('0.05'), true);
        expect(evalResult.transactions).toHaveTransaction({
            from: evaluator.address,
            to: job.address,
            success: true,
        });
        // Money sent to provider
        expect(evalResult.transactions).toHaveTransaction({
            from: job.address,
            to: provider.address,
            success: true,
        });
        expect(await job.getState()).toBe(3); // COMPLETED

        // Verify job data
        const data = await job.getJobData();
        expect(data.resultHash).toBe(RESULT_HASH);
        expect(data.state).toBe(3);
    });

    // ========== REJECT PATH ==========

    it('reject path: create → fund → take → submit → reject → disputed, refund client', async () => {
        const job = await deployFactoryAndCreateJob();

        await job.sendFund(client.getSender(), BUDGET + toNano('0.1'));
        await job.sendTakeJob(provider.getSender(), toNano('0.05'));
        await job.sendSubmitResult(provider.getSender(), toNano('0.05'), RESULT_HASH);

        const evalResult = await job.sendEvaluate(evaluator.getSender(), toNano('0.05'), false);
        expect(evalResult.transactions).toHaveTransaction({
            from: job.address,
            to: client.address,
            success: true,
        });
        expect(await job.getState()).toBe(4); // DISPUTED
    });

    // ========== CANCEL PATH ==========

    it('cancel path: fund → timeout → cancel → refund client', async () => {
        const job = await deployFactoryAndCreateJob();

        await job.sendFund(client.getSender(), BUDGET + toNano('0.1'));
        expect(await job.getState()).toBe(1); // FUNDED

        // Advance time past timeout
        blockchain.now = Math.floor(Date.now() / 1000) + TIMEOUT + 100;

        const cancelResult = await job.sendCancel(client.getSender(), toNano('0.05'));
        expect(cancelResult.transactions).toHaveTransaction({
            from: job.address,
            to: client.address,
            success: true,
        });
        expect(await job.getState()).toBe(5); // CANCELLED
    });

    // ========== AUTO-CLAIM ==========

    it('should allow provider to claim after evaluation timeout', async () => {
        const job = await deployFactoryAndCreateJob();

        await job.sendFund(client.getSender(), BUDGET + toNano('0.1'));
        await job.sendTakeJob(provider.getSender(), toNano('0.05'));
        await job.sendSubmitResult(provider.getSender(), toNano('0.05'), RESULT_HASH);

        // Advance time past evaluation timeout
        blockchain.now = Math.floor(Date.now() / 1000) + EVAL_TIMEOUT + 100;

        const claimResult = await job.sendClaim(provider.getSender(), toNano('0.05'));
        expect(claimResult.transactions).toHaveTransaction({
            from: provider.address,
            to: job.address,
            success: true,
        });
        // Money sent to provider
        expect(claimResult.transactions).toHaveTransaction({
            from: job.address,
            to: provider.address,
            success: true,
        });
        expect(await job.getState()).toBe(3); // COMPLETED
    });

    it('should reject claim before evaluation timeout', async () => {
        const job = await deployFactoryAndCreateJob();

        await job.sendFund(client.getSender(), BUDGET + toNano('0.1'));
        await job.sendTakeJob(provider.getSender(), toNano('0.05'));
        await job.sendSubmitResult(provider.getSender(), toNano('0.05'), RESULT_HASH);

        // Don't advance time
        const result = await job.sendClaim(provider.getSender(), toNano('0.05'));
        expect(result.transactions).toHaveTransaction({
            from: provider.address,
            to: job.address,
            success: false,
            exitCode: 105, // ERR_EVAL_TIMEOUT_NOT_EXPIRED
        });
    });

    it('should reject claim from non-provider', async () => {
        const job = await deployFactoryAndCreateJob();

        await job.sendFund(client.getSender(), BUDGET + toNano('0.1'));
        await job.sendTakeJob(provider.getSender(), toNano('0.05'));
        await job.sendSubmitResult(provider.getSender(), toNano('0.05'), RESULT_HASH);

        blockchain.now = Math.floor(Date.now() / 1000) + EVAL_TIMEOUT + 100;

        const result = await job.sendClaim(outsider.getSender(), toNano('0.05'));
        expect(result.transactions).toHaveTransaction({
            from: outsider.address,
            to: job.address,
            success: false,
            exitCode: 100, // ERR_ACCESS_DENIED
        });
    });

    it('should reject claim if already evaluated', async () => {
        const job = await deployFactoryAndCreateJob();

        await job.sendFund(client.getSender(), BUDGET + toNano('0.1'));
        await job.sendTakeJob(provider.getSender(), toNano('0.05'));
        await job.sendSubmitResult(provider.getSender(), toNano('0.05'), RESULT_HASH);
        await job.sendEvaluate(evaluator.getSender(), toNano('0.05'), true);

        blockchain.now = Math.floor(Date.now() / 1000) + EVAL_TIMEOUT + 100;

        const result = await job.sendClaim(provider.getSender(), toNano('0.05'));
        expect(result.transactions).toHaveTransaction({
            from: provider.address,
            to: job.address,
            success: false,
            exitCode: 101, // ERR_INVALID_STATE (already COMPLETED)
        });
    });

    // ========== QUIT JOB ==========

    it('should allow provider to quit before submit', async () => {
        const job = await deployFactoryAndCreateJob();

        await job.sendFund(client.getSender(), BUDGET + toNano('0.1'));
        await job.sendTakeJob(provider.getSender(), toNano('0.05'));

        const quitResult = await job.sendQuit(provider.getSender(), toNano('0.05'));
        expect(quitResult.transactions).toHaveTransaction({
            from: provider.address,
            to: job.address,
            success: true,
        });

        // Verify provider removed, state still FUNDED
        const data = await job.getJobData();
        expect(data.providerAddress).toBeNull();
        expect(data.state).toBe(1); // FUNDED

        // Another provider can take the job
        const provider2 = await blockchain.treasury('provider2');
        const takeResult = await job.sendTakeJob(provider2.getSender(), toNano('0.05'));
        expect(takeResult.transactions).toHaveTransaction({
            from: provider2.address,
            to: job.address,
            success: true,
        });
    });

    it('should reject quit from non-provider', async () => {
        const job = await deployFactoryAndCreateJob();

        await job.sendFund(client.getSender(), BUDGET + toNano('0.1'));
        await job.sendTakeJob(provider.getSender(), toNano('0.05'));

        const result = await job.sendQuit(outsider.getSender(), toNano('0.05'));
        expect(result.transactions).toHaveTransaction({
            from: outsider.address,
            to: job.address,
            success: false,
            exitCode: 100, // ERR_ACCESS_DENIED
        });
    });

    // ========== SET BUDGET ==========

    it('should allow client to set budget', async () => {
        const job = await deployFactoryAndCreateJob(undefined, 0n);

        const setBudgetResult = await job.sendSetBudget(client.getSender(), toNano('0.05'), BUDGET);
        expect(setBudgetResult.transactions).toHaveTransaction({
            from: client.address,
            to: job.address,
            success: true,
        });

        const data = await job.getJobData();
        expect(data.budget).toBe(BUDGET);
    });

    it('should reject setBudget from non-client', async () => {
        const job = await deployFactoryAndCreateJob(undefined, 0n);

        const result = await job.sendSetBudget(outsider.getSender(), toNano('0.05'), BUDGET);
        expect(result.transactions).toHaveTransaction({
            from: outsider.address,
            to: job.address,
            success: false,
            exitCode: 100, // ERR_ACCESS_DENIED
        });
    });

    it('should reject setBudget when not OPEN', async () => {
        const job = await deployFactoryAndCreateJob();

        await job.sendFund(client.getSender(), BUDGET + toNano('0.1'));

        const result = await job.sendSetBudget(client.getSender(), toNano('0.05'), toNano('10'));
        expect(result.transactions).toHaveTransaction({
            from: client.address,
            to: job.address,
            success: false,
            exitCode: 101, // ERR_INVALID_STATE
        });
    });

    it('should fund with exact budget after setBudget', async () => {
        const job = await deployFactoryAndCreateJob(undefined, 0n);

        await job.sendSetBudget(client.getSender(), toNano('0.05'), toNano('3'));

        const fundResult = await job.sendFund(client.getSender(), toNano('3') + toNano('0.1'));
        expect(fundResult.transactions).toHaveTransaction({
            from: client.address,
            to: job.address,
            success: true,
        });
        expect(await job.getState()).toBe(1); // FUNDED
    });

    it('should reject fund when budget is 0', async () => {
        const job = await deployFactoryAndCreateJob(undefined, 0n);

        const result = await job.sendFund(client.getSender(), toNano('5'));
        expect(result.transactions).toHaveTransaction({
            from: client.address,
            to: job.address,
            success: false,
            exitCode: 106, // ERR_BUDGET_NOT_SET
        });
    });

    // ========== REASON ==========

    it('should store reason on approve', async () => {
        const job = await deployFactoryAndCreateJob();

        await job.sendFund(client.getSender(), BUDGET + toNano('0.1'));
        await job.sendTakeJob(provider.getSender(), toNano('0.05'));
        await job.sendSubmitResult(provider.getSender(), toNano('0.05'), RESULT_HASH);

        await job.sendEvaluate(evaluator.getSender(), toNano('0.05'), true, REASON_HASH);

        const data = await job.getJobData();
        expect(data.reason).toBe(REASON_HASH);
        expect(data.state).toBe(3); // COMPLETED
    });

    it('should store reason on reject', async () => {
        const job = await deployFactoryAndCreateJob();

        await job.sendFund(client.getSender(), BUDGET + toNano('0.1'));
        await job.sendTakeJob(provider.getSender(), toNano('0.05'));
        await job.sendSubmitResult(provider.getSender(), toNano('0.05'), RESULT_HASH);

        await job.sendEvaluate(evaluator.getSender(), toNano('0.05'), false, REASON_HASH);

        const data = await job.getJobData();
        expect(data.reason).toBe(REASON_HASH);
        expect(data.state).toBe(4); // DISPUTED
    });

    it('should work without reason (default 0)', async () => {
        const job = await deployFactoryAndCreateJob();

        await job.sendFund(client.getSender(), BUDGET + toNano('0.1'));
        await job.sendTakeJob(provider.getSender(), toNano('0.05'));
        await job.sendSubmitResult(provider.getSender(), toNano('0.05'), RESULT_HASH);

        await job.sendEvaluate(evaluator.getSender(), toNano('0.05'), true);

        const data = await job.getJobData();
        expect(data.reason).toBe(0n);
        expect(data.state).toBe(3); // COMPLETED
    });

    // ========== RESULT TYPE ==========

    it('should store result type on submit', async () => {
        const job = await deployFactoryAndCreateJob();

        await job.sendFund(client.getSender(), BUDGET + toNano('0.1'));
        await job.sendTakeJob(provider.getSender(), toNano('0.05'));
        await job.sendSubmitResult(provider.getSender(), toNano('0.05'), RESULT_HASH, 1); // TON Storage

        const data = await job.getJobData();
        expect(data.resultType).toBe(1);
        expect(data.resultHash).toBe(RESULT_HASH);
    });

    // ========== SECURITY: UNAUTHORIZED ==========

    it('should reject fund from non-client', async () => {
        const job = await deployFactoryAndCreateJob();

        const result = await job.sendFund(outsider.getSender(), BUDGET);
        expect(result.transactions).toHaveTransaction({
            from: outsider.address,
            to: job.address,
            success: false,
            exitCode: 100, // ERR_ACCESS_DENIED
        });
    });

    it('should reject submit from non-provider', async () => {
        const job = await deployFactoryAndCreateJob();

        await job.sendFund(client.getSender(), BUDGET + toNano('0.1'));
        await job.sendTakeJob(provider.getSender(), toNano('0.05'));

        const result = await job.sendSubmitResult(outsider.getSender(), toNano('0.05'), RESULT_HASH);
        expect(result.transactions).toHaveTransaction({
            from: outsider.address,
            to: job.address,
            success: false,
            exitCode: 100, // ERR_ACCESS_DENIED
        });
    });

    it('should reject evaluate from non-evaluator', async () => {
        const job = await deployFactoryAndCreateJob();

        await job.sendFund(client.getSender(), BUDGET + toNano('0.1'));
        await job.sendTakeJob(provider.getSender(), toNano('0.05'));
        await job.sendSubmitResult(provider.getSender(), toNano('0.05'), RESULT_HASH);

        const result = await job.sendEvaluate(outsider.getSender(), toNano('0.05'), true);
        expect(result.transactions).toHaveTransaction({
            from: outsider.address,
            to: job.address,
            success: false,
            exitCode: 100, // ERR_ACCESS_DENIED
        });
    });

    // ========== EDGE CASES ==========

    it('should reject double submit', async () => {
        const job = await deployFactoryAndCreateJob();

        await job.sendFund(client.getSender(), BUDGET + toNano('0.1'));
        await job.sendTakeJob(provider.getSender(), toNano('0.05'));
        await job.sendSubmitResult(provider.getSender(), toNano('0.05'), RESULT_HASH);

        const result = await job.sendSubmitResult(provider.getSender(), toNano('0.05'), RESULT_HASH);
        expect(result.transactions).toHaveTransaction({
            from: provider.address,
            to: job.address,
            success: false,
            exitCode: 101, // ERR_INVALID_STATE
        });
    });

    it('should reject evaluate without submit', async () => {
        const job = await deployFactoryAndCreateJob();

        await job.sendFund(client.getSender(), BUDGET + toNano('0.1'));
        await job.sendTakeJob(provider.getSender(), toNano('0.05'));

        const result = await job.sendEvaluate(evaluator.getSender(), toNano('0.05'), true);
        expect(result.transactions).toHaveTransaction({
            from: evaluator.address,
            to: job.address,
            success: false,
            exitCode: 101, // ERR_INVALID_STATE
        });
    });

    it('should reject cancel before timeout', async () => {
        const job = await deployFactoryAndCreateJob();

        await job.sendFund(client.getSender(), BUDGET + toNano('0.1'));

        const result = await job.sendCancel(client.getSender(), toNano('0.05'));
        expect(result.transactions).toHaveTransaction({
            from: client.address,
            to: job.address,
            success: false,
            exitCode: 102, // ERR_TIMEOUT_NOT_EXPIRED
        });
    });

    it('should allow cancel when provider taken but timeout expired', async () => {
        const job = await deployFactoryAndCreateJob();

        await job.sendFund(client.getSender(), BUDGET + toNano('0.1'));
        await job.sendTakeJob(provider.getSender(), toNano('0.05'));

        blockchain.now = Math.floor(Date.now() / 1000) + TIMEOUT + 100;

        const result = await job.sendCancel(client.getSender(), toNano('0.05'));
        expect(result.transactions).toHaveTransaction({
            from: client.address,
            to: job.address,
            success: true,
        });
        expect(await job.getState()).toBe(5); // CANCELLED
    });

    it('should reject fund with insufficient amount', async () => {
        const job = await deployFactoryAndCreateJob();

        const result = await job.sendFund(client.getSender(), toNano('0.5'));
        expect(result.transactions).toHaveTransaction({
            from: client.address,
            to: job.address,
            success: false,
            exitCode: 104, // ERR_INSUFFICIENT_FUNDS
        });
    });

    // ========== CLIENT AS EVALUATOR ==========

    it('client can be evaluator when evaluator = client', async () => {
        const job = await deployFactoryAndCreateJob(client.address);

        await job.sendFund(client.getSender(), BUDGET + toNano('0.1'));
        await job.sendTakeJob(provider.getSender(), toNano('0.05'));
        await job.sendSubmitResult(provider.getSender(), toNano('0.05'), RESULT_HASH);

        const evalResult = await job.sendEvaluate(client.getSender(), toNano('0.05'), true);
        expect(evalResult.transactions).toHaveTransaction({
            from: client.address,
            to: job.address,
            success: true,
        });
        expect(await job.getState()).toBe(3); // COMPLETED
    });
});
