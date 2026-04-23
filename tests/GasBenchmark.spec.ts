import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, toNano, Transaction } from '@ton/core';
import { Job, JobOpcodes } from '../wrappers/Job';
import { JobFactory } from '../wrappers/JobFactory';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';

// Measures per-handler gas for a representative lifecycle so future
// regressions (and OPT-2/O-4/O-8 gains) are visible in the test output.
// Pretty-prints a markdown table at the end. Sandbox numbers are
// deterministic; run with `npx jest tests/GasBenchmark.spec.ts` and
// paste the table into commit messages.

function computeGas(tx: Transaction): bigint {
    const desc = tx.description as any;
    const cp = desc?.computePhase;
    if (cp && typeof cp === 'object' && 'gasUsed' in cp) {
        return BigInt(cp.gasUsed);
    }
    return 0n;
}

function handlerTx(txs: Transaction[], to: string): Transaction | undefined {
    // The first tx with dest == job is the handler under measurement.
    return txs.find((t) => {
        const info = t.inMessage?.info as any;
        return info?.type === 'internal' && info?.dest?.toString?.() === to;
    });
}

describe('GasBenchmark — v2 TON job handler gas', () => {
    let jobCode: Cell;
    let factoryCode: Cell;

    beforeAll(async () => {
        jobCode = await compile('Job');
        factoryCode = await compile('JobFactory');
    }, 30000);

    it('emits a markdown table of per-handler gas', async () => {
        const blockchain = await Blockchain.create();
        const client = await blockchain.treasury('client');
        const provider = await blockchain.treasury('provider');
        const evaluator = await blockchain.treasury('evaluator');

        const factory = blockchain.openContract(
            JobFactory.createFromConfig({ owner: client.address, jobCode }, factoryCode),
        );
        await factory.sendDeploy(client.getSender(), toNano('0.1'));

        const rows: { label: string; gas: bigint }[] = [];

        // Scenario 1: FIXED happy path
        const budget = toNano('3');
        const createRes = await factory.sendCreateJob(client.getSender(), toNano('0.1'), {
            evaluatorAddress: evaluator.address,
            budget,
            descriptionHash: BigInt('0x' + 'a'.repeat(64)),
            timeout: 86400,
            evaluationTimeout: 86400,
        });
        const jobAddr = await factory.getJobAddress(0);
        const job = blockchain.openContract(Job.createFromAddress(jobAddr));

        const factoryHandler = handlerTx(createRes.transactions, factory.address.toString());
        const initHandler = handlerTx(createRes.transactions, jobAddr.toString());
        if (factoryHandler) rows.push({ label: 'CreateJob (factory)', gas: computeGas(factoryHandler) });
        if (initHandler) rows.push({ label: 'InitJob (child)', gas: computeGas(initHandler) });

        const fundRes = await job.sendFund(client.getSender(), budget + toNano('0.1'));
        const fundHandler = handlerTx(fundRes.transactions, jobAddr.toString());
        if (fundHandler) rows.push({ label: 'FundJob', gas: computeGas(fundHandler) });

        const takeRes = await job.sendTakeJob(provider.getSender(), toNano('0.05'));
        const takeHandler = handlerTx(takeRes.transactions, jobAddr.toString());
        if (takeHandler) rows.push({ label: 'TakeJob (OPT-2 lazy mode gate)', gas: computeGas(takeHandler) });

        const submitRes = await job.sendSubmitResult(
            provider.getSender(),
            toNano('0.05'),
            BigInt('0x' + 'b'.repeat(64)),
        );
        const submitHandler = handlerTx(submitRes.transactions, jobAddr.toString());
        if (submitHandler) rows.push({ label: 'SubmitResult (O-4 reuse v2)', gas: computeGas(submitHandler) });

        const evalRes = await job.sendEvaluate(evaluator.getSender(), toNano('0.2'), true);
        const evalHandler = handlerTx(evalRes.transactions, jobAddr.toString());
        if (evalHandler) rows.push({ label: 'EvaluateJob approve (O-4 reuse v2)', gas: computeGas(evalHandler) });

        const commitRes = await job.sendCommitSettlement(provider.getSender(), toNano('0.05'));
        const commitHandler = handlerTx(commitRes.transactions, jobAddr.toString());
        if (commitHandler) rows.push({ label: 'CommitSettlement', gas: computeGas(commitHandler) });

        // Scenario 2: SetBudget+ in FUNDED (O-4 rebuildWithBudget)
        await factory.sendCreateJob(client.getSender(), toNano('0.1'), {
            evaluatorAddress: evaluator.address,
            budget,
            descriptionHash: BigInt('0x' + '5'.repeat(64)),
            timeout: 86400,
            evaluationTimeout: 86400,
        });
        const job2Addr = await factory.getJobAddress(1);
        const job2 = blockchain.openContract(Job.createFromAddress(job2Addr));
        await job2.sendFund(client.getSender(), budget + toNano('0.1'));
        const setB = await job2.sendSetBudget(client.getSender(), toNano('1.1'), toNano('4'));
        const setBH = handlerTx(setB.transactions, job2Addr.toString());
        if (setBH) rows.push({ label: 'SetBudget+ FUNDED (O-4 rebuildWithBudget)', gas: computeGas(setBH) });

        // Scenario 3: Cancel in OPEN
        await factory.sendCreateJob(client.getSender(), toNano('0.1'), {
            evaluatorAddress: evaluator.address,
            budget: toNano('2'),
            descriptionHash: BigInt('0x' + '7'.repeat(64)),
            timeout: 86400,
            evaluationTimeout: 86400,
        });
        const job3Addr = await factory.getJobAddress(2);
        const job3 = blockchain.openContract(Job.createFromAddress(job3Addr));
        const cancelR = await job3.sendCancel(client.getSender(), toNano('0.05'));
        const cancelH = handlerTx(cancelR.transactions, job3Addr.toString());
        if (cancelH) rows.push({ label: 'CancelJob in OPEN', gas: computeGas(cancelH) });

        console.log('\n========== ENACT v2 gas benchmark (TON handlers) ==========');
        console.log('| Handler | Gas units |');
        console.log('|---|---:|');
        for (const r of rows) {
            console.log(`| ${r.label} | ${r.gas.toString()} |`);
        }
        console.log('========================================================\n');

        // Assert every handler was measured — keeps the list honest.
        expect(rows.length).toBeGreaterThanOrEqual(9);
        for (const r of rows) {
            expect(r.gas).toBeGreaterThan(0n);
        }
    }, 30000);
});
