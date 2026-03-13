import { toNano } from '@ton/core';
import { JobFactory } from '../wrappers/JobFactory';
import { compile, NetworkProvider } from '@ton/blueprint';

export async function run(provider: NetworkProvider) {
    const jobCode = await compile('Job');
    const factoryCode = await compile('JobFactory');

    const jobFactory = provider.open(
        JobFactory.createFromConfig(
            {
                owner: provider.sender().address!,
                jobCode,
                protocolFeeBps: 0,
            },
            factoryCode
        )
    );

    await jobFactory.sendDeploy(provider.sender(), toNano('0.05'));

    await provider.waitForDeploy(jobFactory.address);

    console.log('JobFactory deployed at:', jobFactory.address.toString());
    console.log('Next Job ID:', await jobFactory.getNextJobId());
}
