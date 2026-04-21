import {
    Address,
    beginCell,
    Cell,
    Contract,
    ContractABI,
    contractAddress,
    ContractProvider,
    Sender,
    SendMode,
    toNano,
    TupleItemInt,
} from '@ton/core';

export const FactoryOpcodes = {
    createJob: 0x00000010,
};

export type JobFactoryConfig = {
    owner: Address;
    jobCode: Cell;
};

export function jobFactoryConfigToCell(config: JobFactoryConfig): Cell {
    return beginCell()
        .storeAddress(config.owner)
        .storeRef(config.jobCode)
        .storeUint(0, 32) // nextJobId
        .endCell();
}

export class JobFactory implements Contract {
    abi: ContractABI = { name: 'JobFactory' };

    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new JobFactory(address);
    }

    static createFromConfig(config: JobFactoryConfig, code: Cell, workchain = 0) {
        const data = jobFactoryConfigToCell(config);
        const init = { code, data };
        return new JobFactory(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    async sendCreateJob(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        params: {
            evaluatorAddress: Address;
            budget: bigint;
            descriptionHash: bigint;
            timeout: number;
            evaluationTimeout?: number;
        }
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(FactoryOpcodes.createJob, 32)
                .storeAddress(params.evaluatorAddress)
                .storeCoins(params.budget)
                .storeUint(params.descriptionHash, 256)
                .storeUint(params.timeout, 32)
                .storeUint(params.evaluationTimeout ?? 86400, 32)
                .endCell(),
        });
    }

    async getJobAddress(provider: ContractProvider, jobId: number): Promise<Address> {
        const result = await provider.get('get_job_address', [
            { type: 'int', value: BigInt(jobId) },
        ]);
        return result.stack.readAddress();
    }

    async getNextJobId(provider: ContractProvider): Promise<number> {
        const result = await provider.get('get_next_job_id', []);
        return result.stack.readNumber();
    }

}
