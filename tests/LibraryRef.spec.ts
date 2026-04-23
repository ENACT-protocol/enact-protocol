import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { beginCell, Cell, Dictionary, toNano } from '@ton/core';
import { Job, JobOpcodes } from '../wrappers/Job';
import { JobFactoryLib } from '../wrappers/JobFactoryLib';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';

// Confirms that a factory which stores only a 256-bit code hash and
// deploys children with an exotic library-ref cell as their code works
// end-to-end under the sandbox's emulated global-library registry.
// If this passes, the v2-lib factory will behave identically on
// mainnet once the CodeLibrary publisher has registered Job bytecode
// as a public library (mode=2) on masterchain.

describe('Library-ref factory (v2-lib)', () => {
    let jobCode: Cell;
    let factoryCode: Cell;

    beforeAll(async () => {
        jobCode = await compile('Job');
        factoryCode = await compile('JobFactoryLib');
    }, 30000);

    it('happy path: create -> fund -> take -> submit -> approve -> commit with library code', async () => {
        const blockchain = await Blockchain.create();

        // Register the Job bytecode as a library. In sandbox we push
        // the code into the global libs dictionary by hash; the TVM
        // resolver then handles exotic library-ref cells transparently.
        const libsDict = Dictionary.empty(
            Dictionary.Keys.Buffer(32),
            Dictionary.Values.Cell(),
        );
        libsDict.set(jobCode.hash(), jobCode);
        blockchain.libs = beginCell().storeDictDirect(libsDict).endCell();

        const client = await blockchain.treasury('client');
        const provider = await blockchain.treasury('provider');
        const evaluator = await blockchain.treasury('evaluator');

        const factory = blockchain.openContract(
            JobFactoryLib.createFromConfig(
                { owner: client.address, jobCodeHash: jobCode.hash() },
                factoryCode,
            ),
        );
        const deployRes = await factory.sendDeploy(client.getSender(), toNano('0.1'));
        expect(deployRes.transactions).toHaveTransaction({
            from: client.address,
            to: factory.address,
            deploy: true,
            success: true,
        });

        const budget = toNano('3');
        await factory.sendCreateJob(client.getSender(), toNano('0.1'), {
            evaluatorAddress: evaluator.address,
            budget,
            descriptionHash: BigInt('0x' + 'a'.repeat(64)),
            timeout: 86400,
            evaluationTimeout: 86400,
        });

        const jobAddress = await factory.getJobAddress(0);
        const job = blockchain.openContract(Job.createFromAddress(jobAddress));

        // Fund
        await job.sendFund(client.getSender(), budget + toNano('0.1'));
        expect(await job.getState()).toBe(1); // FUNDED

        // Take (library lookup happens here — if the exotic cell or
        // registry is misconfigured, TVM would fail at lookup before
        // reaching the handler).
        await job.sendTakeJob(provider.getSender(), toNano('0.05'));
        expect(await job.getState()).toBe(1);

        // Submit
        await job.sendSubmitResult(
            provider.getSender(),
            toNano('0.05'),
            BigInt('0x' + 'b'.repeat(64)),
        );
        expect(await job.getState()).toBe(2); // SUBMITTED

        // Evaluate + commit
        await job.sendEvaluate(evaluator.getSender(), toNano('0.2'), true);
        expect(await job.getState()).toBe(6); // SETTLING_COMPLETED
        await job.sendCommitSettlement(provider.getSender(), toNano('0.05'));
        expect(await job.getState()).toBe(3); // COMPLETED
    }, 60000);
});
