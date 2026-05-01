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
} from '@ton/core';

export const FactoryOpcodes = {
    createJob: 0x8204df3b, // CRC32("op::create_job")
};

// Modes mirror lib/constants.tolk: MODE_FIXED is first-come TakeJob; MODE_APPLICATION
// requires AcceptProvider + ed25519-signed bid.
export const JobMode = {
    FIXED: 0,
    APPLICATION: 1,
} as const;

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

// Helper: build the v2 ref cell used by CreateJob/InitJob. Kept exported
// so SDK callers can reproduce the exact byte layout for signing flows.
//
// Layout (post-hook-gas-param): mode(8) + applicationWindow(32) +
// Maybe(hookAddress) + hookGas(coins). Pass hookGas=0n to fall back on
// the contract-side DEFAULT_HOOK_GAS (0.01 TON).
export function buildV2InitParams(params: {
    mode?: number;
    applicationWindow?: number;
    hookAddress?: Address | null;
    hookGas?: bigint;
}): Cell {
    const mode = params.mode ?? JobMode.FIXED;
    const applicationWindow = params.applicationWindow ?? 0;
    const hook = params.hookAddress ?? null;
    const hookGas = params.hookGas ?? 0n;
    const b = beginCell()
        .storeUint(mode, 8)
        .storeUint(applicationWindow, 32);
    if (hook) {
        b.storeBit(true).storeAddress(hook);
    } else {
        b.storeBit(false);
    }
    b.storeCoins(hookGas);
    return b.endCell();
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
            mode?: number;
            applicationWindow?: number;
            hookAddress?: Address | null;
            hookGas?: bigint;
        }
    ) {
        const v2 = buildV2InitParams({
            mode: params.mode,
            applicationWindow: params.applicationWindow,
            hookAddress: params.hookAddress,
            hookGas: params.hookGas,
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
