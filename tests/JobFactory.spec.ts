import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, toNano } from '@ton/core';
import { JobFactory } from '../wrappers/JobFactory';
import { Job } from '../wrappers/Job';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';

describe('JobFactory', () => {
    let factoryCode: Cell;
    let jobCode: Cell;

    beforeAll(async () => {
        factoryCode = await compile('JobFactory');
        jobCode = await compile('Job');
    }, 30000);

    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let jobFactory: SandboxContract<JobFactory>;

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        deployer = await blockchain.treasury('deployer');

        jobFactory = blockchain.openContract(
            JobFactory.createFromConfig(
                { owner: deployer.address, jobCode },
                factoryCode
            )
        );

        const deployResult = await jobFactory.sendDeploy(deployer.getSender(), toNano('0.1'));
        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: jobFactory.address,
            deploy: true,
            success: true,
        });
    });

    it('should deploy', async () => {
        const nextId = await jobFactory.getNextJobId();
        expect(nextId).toBe(0);
    });

    it('should create a job and increment counter', async () => {
        const evaluator = await blockchain.treasury('evaluator');

        await jobFactory.sendCreateJob(deployer.getSender(), toNano('0.1'), {
            evaluatorAddress: evaluator.address,
            budget: toNano('5'),
            descriptionHash: BigInt('0x' + 'a'.repeat(64)),
            timeout: 86400,
            evaluationTimeout: 86400,
        });

        const nextId = await jobFactory.getNextJobId();
        expect(nextId).toBe(1);
    });

    it('should create multiple jobs with correct addresses', async () => {
        const evaluator = await blockchain.treasury('evaluator');
        const params = {
            evaluatorAddress: evaluator.address,
            budget: toNano('5'),
            descriptionHash: BigInt('0x' + 'a'.repeat(64)),
            timeout: 86400,
            evaluationTimeout: 86400,
        };

        await jobFactory.sendCreateJob(deployer.getSender(), toNano('0.1'), params);
        await jobFactory.sendCreateJob(deployer.getSender(), toNano('0.1'), params);
        await jobFactory.sendCreateJob(deployer.getSender(), toNano('0.1'), params);

        const nextId = await jobFactory.getNextJobId();
        expect(nextId).toBe(3);

        // Verify addresses are different
        const addr0 = await jobFactory.getJobAddress(0);
        const addr1 = await jobFactory.getJobAddress(1);
        const addr2 = await jobFactory.getJobAddress(2);

        expect(addr0.toString()).not.toBe(addr1.toString());
        expect(addr1.toString()).not.toBe(addr2.toString());
    });

    it('should deploy job contract at computed address', async () => {
        const evaluator = await blockchain.treasury('evaluator');

        const result = await jobFactory.sendCreateJob(deployer.getSender(), toNano('0.1'), {
            evaluatorAddress: evaluator.address,
            budget: toNano('5'),
            descriptionHash: BigInt('0x' + 'a'.repeat(64)),
            timeout: 86400,
            evaluationTimeout: 86400,
        });

        const jobAddress = await jobFactory.getJobAddress(0);

        expect(result.transactions).toHaveTransaction({
            from: jobFactory.address,
            to: jobAddress,
            deploy: true,
            success: true,
        });
    });

    it('should reject job with timeout too short', async () => {
        const evaluator = await blockchain.treasury('evaluator');

        const result = await jobFactory.sendCreateJob(deployer.getSender(), toNano('0.1'), {
            evaluatorAddress: evaluator.address,
            budget: toNano('5'),
            descriptionHash: BigInt('0x' + 'a'.repeat(64)),
            timeout: 60, // below MIN_TIMEOUT
            evaluationTimeout: 86400,
        });

        expect(result.transactions).toHaveTransaction({
            from: deployer.address,
            to: jobFactory.address,
            success: false,
            exitCode: 202, // ERR_INVALID_TIMEOUT
        });
    });

    it('should reject job with timeout too long', async () => {
        const evaluator = await blockchain.treasury('evaluator');

        const result = await jobFactory.sendCreateJob(deployer.getSender(), toNano('0.1'), {
            evaluatorAddress: evaluator.address,
            budget: toNano('5'),
            descriptionHash: BigInt('0x' + 'a'.repeat(64)),
            timeout: 3600000, // above MAX_TIMEOUT
            evaluationTimeout: 86400,
        });

        expect(result.transactions).toHaveTransaction({
            from: deployer.address,
            to: jobFactory.address,
            success: false,
            exitCode: 202, // ERR_INVALID_TIMEOUT
        });
    });

    it('should reject job with evaluation timeout too short', async () => {
        const evaluator = await blockchain.treasury('evaluator');

        const result = await jobFactory.sendCreateJob(deployer.getSender(), toNano('0.1'), {
            evaluatorAddress: evaluator.address,
            budget: toNano('5'),
            descriptionHash: BigInt('0x' + 'a'.repeat(64)),
            timeout: 86400,
            evaluationTimeout: 60, // below MIN_TIMEOUT
        });

        expect(result.transactions).toHaveTransaction({
            from: deployer.address,
            to: jobFactory.address,
            success: false,
            exitCode: 202, // ERR_INVALID_TIMEOUT
        });
    });

    it('should create job with budget = 0 (setBudget later)', async () => {
        const evaluator = await blockchain.treasury('evaluator');

        const result = await jobFactory.sendCreateJob(deployer.getSender(), toNano('0.1'), {
            evaluatorAddress: evaluator.address,
            budget: 0n,
            descriptionHash: BigInt('0x' + 'a'.repeat(64)),
            timeout: 86400,
            evaluationTimeout: 86400,
        });

        const jobAddress = await jobFactory.getJobAddress(0);
        expect(result.transactions).toHaveTransaction({
            from: jobFactory.address,
            to: jobAddress,
            deploy: true,
            success: true,
        });
    });
});
