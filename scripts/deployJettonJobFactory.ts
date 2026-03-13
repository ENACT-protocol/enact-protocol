import { toNano } from '@ton/core';
import { JobFactory } from '../wrappers/JobFactory';
import { compile, NetworkProvider } from '@ton/blueprint';

export async function run(provider: NetworkProvider) {
    const jettonJobCode = await compile('JettonJob');
    const factoryCode = await compile('JettonJobFactory');

    const factory = provider.open(
        JobFactory.createFromConfig(
            {
                owner: provider.sender().address!,
                jobCode: jettonJobCode,
                protocolFeeBps: 0,
            },
            factoryCode
        )
    );

    await factory.sendDeploy(provider.sender(), toNano('0.05'));

    await provider.waitForDeploy(factory.address);

    console.log('JettonJobFactory deployed at:', factory.address.toString());
    console.log('Next Job ID:', await factory.getNextJobId());
}
