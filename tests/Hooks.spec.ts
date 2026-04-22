import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, toNano } from '@ton/core';
import { HookOpcodes, Job, JobOpcodes } from '../wrappers/Job';
import { JobFactory } from '../wrappers/JobFactory';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';

// v2 afterEvaluate hook: optional per-job hook address receives a
// notification when EvaluateJob or ClaimJob promotes the job into
// SETTLING. The notification body is
//   opcode(32) + jobId(32) + approved(8) + hasProvider(1) + [providerAddr].
// The hook is best-effort (IGNORE_ERRORS) — a broken hook must never
// stall settlement.

describe('afterEvaluate hook', () => {
    let jobCode: Cell;
    let factoryCode: Cell;

    beforeAll(async () => {
        jobCode = await compile('Job');
        factoryCode = await compile('JobFactory');
    }, 30000);

    let blockchain: Blockchain;
    let client: SandboxContract<TreasuryContract>;
    let provider: SandboxContract<TreasuryContract>;
    let evaluator: SandboxContract<TreasuryContract>;
    let hook: SandboxContract<TreasuryContract>;

    const TIMEOUT = 86400;
    const EVAL_TIMEOUT = 86400;
    const BUDGET = toNano('3');
    const DESC_HASH = BigInt('0x' + 'a'.repeat(64));
    const RESULT_HASH = BigInt('0x' + 'b'.repeat(64));

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        client = await blockchain.treasury('client');
        provider = await blockchain.treasury('provider');
        evaluator = await blockchain.treasury('evaluator');
        hook = await blockchain.treasury('hook');
    });

    async function deployJobWithHook(hookedWith: boolean) {
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
            hookAddress: hookedWith ? hook.address : null,
        });
        const addr = await factory.getJobAddress(0);
        const job = blockchain.openContract(Job.createFromAddress(addr));
        await job.sendFund(client.getSender(), BUDGET + toNano('0.1'));
        await job.sendTakeJob(provider.getSender(), toNano('0.05'));
        await job.sendSubmitResult(provider.getSender(), toNano('0.05'), RESULT_HASH);
        return job;
    }

    it('EvaluateJob approve fires afterEvaluate to hook', async () => {
        const job = await deployJobWithHook(true);
        const res = await job.sendEvaluate(evaluator.getSender(), toNano('0.2'), true);

        expect(res.transactions).toHaveTransaction({
            from: job.address,
            to: hook.address,
            success: true,
        });
    });

    it('EvaluateJob reject fires afterEvaluate with approved=0', async () => {
        const job = await deployJobWithHook(true);
        const res = await job.sendEvaluate(evaluator.getSender(), toNano('0.2'), false);
        // Confirm the hook got a message. Body content is verified by
        // decoding the outgoing message.
        const hookTx = res.transactions.find((t) => {
            const info = t.inMessage?.info as any;
            return info?.type === 'internal'
                && info?.src?.toString?.() === job.address.toString()
                && info?.dest?.toString?.() === hook.address.toString();
        });
        expect(hookTx).toBeTruthy();

        const body = hookTx!.inMessage!.body.beginParse();
        expect(body.loadUint(32)).toBe(HookOpcodes.afterEvaluate);
        body.loadUint(32); // jobId
        expect(body.loadUint(8)).toBe(0); // approved = 0
    });

    it('ClaimJob fires afterEvaluate with approved=1 (implicit approval)', async () => {
        const job = await deployJobWithHook(true);
        // Fast-forward past the evaluator timeout.
        const subAt = (await job.getJobData()).submittedAt;
        blockchain.now = subAt + EVAL_TIMEOUT + 1;

        const res = await job.sendClaim(provider.getSender(), toNano('0.2'));
        const hookTx = res.transactions.find((t) => {
            const info = t.inMessage?.info as any;
            return info?.src?.toString?.() === job.address.toString()
                && info?.dest?.toString?.() === hook.address.toString();
        });
        expect(hookTx).toBeTruthy();
        const body = hookTx!.inMessage!.body.beginParse();
        expect(body.loadUint(32)).toBe(HookOpcodes.afterEvaluate);
        body.loadUint(32); // jobId
        expect(body.loadUint(8)).toBe(1); // claim counts as approval
    });

    it('no hook configured → no afterEvaluate message', async () => {
        const job = await deployJobWithHook(false);
        const res = await job.sendEvaluate(evaluator.getSender(), toNano('0.2'), true);

        const hookTx = res.transactions.find((t) => {
            const info = t.inMessage?.info as any;
            return info?.src?.toString?.() === job.address.toString()
                && info?.dest?.toString?.() === hook.address.toString();
        });
        expect(hookTx).toBeUndefined();
        // Settlement must still succeed.
        expect(await job.getState()).toBe(6); // SETTLING_COMPLETED
    });

    it('hook failure does not revert the settlement', async () => {
        // Use a non-existent hook address (an uninitialized account) —
        // hook send fails silently thanks to SEND_MODE_IGNORE_ERRORS.
        // Just confirm settlement still goes through.
        const ghost = await blockchain.treasury('ghost-hook');
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
            hookAddress: ghost.address,
        });
        const job = blockchain.openContract(Job.createFromAddress(await factory.getJobAddress(0)));
        await job.sendFund(client.getSender(), BUDGET + toNano('0.1'));
        await job.sendTakeJob(provider.getSender(), toNano('0.05'));
        await job.sendSubmitResult(provider.getSender(), toNano('0.05'), RESULT_HASH);

        const res = await job.sendEvaluate(evaluator.getSender(), toNano('0.2'), true);
        expect(res.transactions).toHaveTransaction({
            from: evaluator.address,
            to: job.address,
            success: true,
        });
        expect(await job.getState()).toBe(6); // SETTLING_COMPLETED
    });
});
