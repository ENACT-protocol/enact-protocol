import { toNano, Address } from '@ton/core';
import { JobFactory } from '../wrappers/JobFactory';
import { Job } from '../wrappers/Job';
import { compile, NetworkProvider } from '@ton/blueprint';

export async function run(provider: NetworkProvider) {
    const jobCode = await compile('Job');
    const factoryCode = await compile('JobFactory');

    const sender = provider.sender();
    const senderAddr = sender.address!;

    // Step 1: Deploy factory
    console.log('=== ENACT Protocol Demo ===\n');
    console.log('Step 1: Deploying JobFactory...');

    const factory = provider.open(
        JobFactory.createFromConfig(
            { owner: senderAddr, jobCode, protocolFeeBps: 0 },
            factoryCode
        )
    );

    await factory.sendDeploy(sender, toNano('0.05'));
    await provider.waitForDeploy(factory.address);
    console.log('Factory deployed at:', factory.address.toString());

    // Step 2: Create a job (client = sender, evaluator = sender for demo)
    console.log('\nStep 2: Creating Job...');
    const descHash = BigInt('0x' + Buffer.from('Analyze $DOGS token').toString('hex').padEnd(64, '0'));

    await factory.sendCreateJob(sender, toNano('0.15'), {
        evaluatorAddress: senderAddr, // self-evaluate for demo
        budget: toNano('1'),
        descriptionHash: descHash,
        timeout: 86400,
    });

    // Wait a bit for the transaction to process
    const jobAddress = await factory.getJobAddress(0);
    console.log('Job created at:', jobAddress.toString());

    const job = provider.open(Job.createFromAddress(jobAddress));

    // Step 3: Fund the job
    console.log('\nStep 3: Funding Job with 1 TON...');
    await job.sendFund(sender, toNano('1.1'));

    let state = await job.getState();
    console.log('Job state after fund:', state, '(1 = FUNDED)');

    // Step 4: Take the job (provider = sender for demo)
    console.log('\nStep 4: Taking Job as provider...');
    await job.sendTakeJob(sender, toNano('0.05'));

    // Step 5: Submit result
    console.log('\nStep 5: Submitting result...');
    const resultHash = BigInt('0x' + Buffer.from('DOGS analysis complete').toString('hex').padEnd(64, '0'));
    await job.sendSubmitResult(sender, toNano('0.05'), resultHash);

    state = await job.getState();
    console.log('Job state after submit:', state, '(2 = SUBMITTED)');

    // Step 6: Evaluate (approve)
    console.log('\nStep 6: Evaluating (approve)...');
    await job.sendEvaluate(sender, toNano('0.05'), true);

    state = await job.getState();
    console.log('Job state after evaluate:', state, '(3 = COMPLETED)');

    // Final status
    console.log('\n=== Demo Complete ===');
    const data = await job.getJobData();
    console.log('Final job data:', {
        jobId: data.jobId,
        state: data.state,
        client: data.clientAddress.toString(),
        provider: data.providerAddress?.toString(),
    });
}
