import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, Cell, toNano } from '@ton/core';
import { JettonJob } from '../wrappers/JettonJob';
import { JettonJobFactory } from '../wrappers/JettonJobFactory';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { randomBytes } from 'crypto';

// v2 multi-jetton: CreateJob accepts an optional `jettonMaster` address
// carried as trusted metadata (the contract does not verify the wallet
// derivation on-chain — see design notes in jetton_job.tolk). The master
// surfaces via get_v2_data so SDKs can pick the right icon/symbol and
// so evaluators can route payouts.

describe('MultiJetton metadata', () => {
    let jettonJobCode: Cell;
    let jettonFactoryCode: Cell;

    beforeAll(async () => {
        jettonJobCode = await compile('JettonJob');
        jettonFactoryCode = await compile('JettonJobFactory');
    }, 30000);

    let blockchain: Blockchain;
    let client: SandboxContract<TreasuryContract>;
    let evaluator: SandboxContract<TreasuryContract>;

    const TIMEOUT = 86400;
    const EVAL_TIMEOUT = 86400;
    const DESC_HASH = BigInt('0x' + 'a'.repeat(64));

    function randomAddress(): Address {
        return new Address(0, randomBytes(32));
    }

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        client = await blockchain.treasury('client');
        evaluator = await blockchain.treasury('evaluator');
    });

    async function deployAndCreate(params: { jettonMaster?: Address | null }) {
        const factory = blockchain.openContract(
            JettonJobFactory.createFromConfig({ owner: client.address, jobCode: jettonJobCode }, jettonFactoryCode),
        );
        await factory.sendDeploy(client.getSender(), toNano('0.1'));
        await factory.sendCreateJob(client.getSender(), toNano('0.1'), {
            evaluatorAddress: evaluator.address,
            budget: 1000n,
            descriptionHash: DESC_HASH,
            timeout: TIMEOUT,
            evaluationTimeout: EVAL_TIMEOUT,
            jettonMaster: params.jettonMaster ?? null,
        });
        const addr = await factory.getJobAddress(0);
        return blockchain.openContract(JettonJob.createFromAddress(addr));
    }

    it('defaults jettonMaster to null when not supplied', async () => {
        const job = await deployAndCreate({});
        const v2 = await job.getV2Data();
        expect(v2.jettonMaster).toBeNull();
    });

    it('stores USDT master address', async () => {
        // Real USDT mainnet master (exposed for display only; the
        // contract does not enforce that jettonWallet actually derives
        // from it).
        const usdtMaster = Address.parse('EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs');
        const job = await deployAndCreate({ jettonMaster: usdtMaster });
        const v2 = await job.getV2Data();
        expect(v2.jettonMaster?.equals(usdtMaster)).toBe(true);
    });

    it('different masters produce different jobs with stable metadata', async () => {
        const m1 = randomAddress();
        const m2 = randomAddress();

        const factory = blockchain.openContract(
            JettonJobFactory.createFromConfig({ owner: client.address, jobCode: jettonJobCode }, jettonFactoryCode),
        );
        await factory.sendDeploy(client.getSender(), toNano('0.1'));
        await factory.sendCreateJob(client.getSender(), toNano('0.1'), {
            evaluatorAddress: evaluator.address,
            budget: 1000n,
            descriptionHash: DESC_HASH,
            timeout: TIMEOUT,
            evaluationTimeout: EVAL_TIMEOUT,
            jettonMaster: m1,
        });
        await factory.sendCreateJob(client.getSender(), toNano('0.1'), {
            evaluatorAddress: evaluator.address,
            budget: 1000n,
            descriptionHash: DESC_HASH,
            timeout: TIMEOUT,
            evaluationTimeout: EVAL_TIMEOUT,
            jettonMaster: m2,
        });

        const j1 = blockchain.openContract(JettonJob.createFromAddress(await factory.getJobAddress(0)));
        const j2 = blockchain.openContract(JettonJob.createFromAddress(await factory.getJobAddress(1)));

        expect((await j1.getV2Data()).jettonMaster?.equals(m1)).toBe(true);
        expect((await j2.getV2Data()).jettonMaster?.equals(m2)).toBe(true);
    });
});
