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
} from '@ton/core';

import { buildV2InitParams, FactoryOpcodes, JobMode } from './JobFactory';

// v2-lib factory wrapper: same CreateJob opcode + v2 ref payload as the
// original JobFactory, but storage holds a 256-bit jobCodeHash (pointing
// at a public library cell on masterchain) instead of an inline code
// cell. Deterministic addresses differ from v2-opt because the storage
// layout changed; that's intentional, v2-lib is a parallel deploy.

export { FactoryOpcodes, JobMode, buildV2InitParams };

export type JobFactoryLibConfig = {
    owner: Address;
    jobCodeHash: Buffer; // 32 bytes — hash of the library cell published on masterchain
};

export function jobFactoryLibConfigToCell(config: JobFactoryLibConfig): Cell {
    if (config.jobCodeHash.length !== 32) {
        throw new Error('jobCodeHash must be 32 bytes');
    }
    return beginCell()
        .storeAddress(config.owner)
        .storeBuffer(config.jobCodeHash) // uint256 stored as 32 raw bytes
        .storeUint(0, 32)
        .endCell();
}

export class JobFactoryLib implements Contract {
    abi: ContractABI = { name: 'JobFactoryLib' };

    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new JobFactoryLib(address);
    }

    static createFromConfig(config: JobFactoryLibConfig, code: Cell, workchain = 0) {
        const data = jobFactoryLibConfigToCell(config);
        const init = { code, data };
        return new JobFactoryLib(contractAddress(workchain, init), init);
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
            mode?: number;
            applicationWindow?: number;
            hookAddress?: Address | null;
        },
    ) {
        const v2 = buildV2InitParams({
            mode: params.mode,
            applicationWindow: params.applicationWindow,
            hookAddress: params.hookAddress,
        });
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
                .storeRef(v2)
                .endCell(),
        });
    }

    async getJobAddress(provider: ContractProvider, jobId: number): Promise<Address> {
        const r = await provider.get('get_job_address', [
            { type: 'int', value: BigInt(jobId) },
        ]);
        return r.stack.readAddress();
    }

    async getNextJobId(provider: ContractProvider): Promise<number> {
        const r = await provider.get('get_next_job_id', []);
        return r.stack.readNumber();
    }
}
