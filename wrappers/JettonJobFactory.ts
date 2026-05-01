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

// Same opcode as TON factory — CreateJob body differs only in the v2
// ref payload shape (jetton variant carries an extra jettonMaster).
export const JettonFactoryOpcodes = {
    createJob: 0x8204df3b, // CRC32("op::create_job")
};

export const JobMode = {
    FIXED: 0,
    APPLICATION: 1,
} as const;

export type JettonJobFactoryConfig = {
    owner: Address;
    jobCode: Cell;
};

export function jettonJobFactoryConfigToCell(config: JettonJobFactoryConfig): Cell {
    return beginCell()
        .storeAddress(config.owner)
        .storeRef(config.jobCode)
        .storeUint(0, 32)
        .endCell();
}

// Build the jetton-variant v2 ref: mode + applicationWindow +
// hookAddress? + jettonMaster? + hookGas. Kept parallel to TON's
// buildV2InitParams; the trailing jettonMaster Maybe and the hookGas
// coins are jetton-specific.
export function buildJettonV2InitParams(params: {
    mode?: number;
    applicationWindow?: number;
    hookAddress?: Address | null;
    jettonMaster?: Address | null;
    hookGas?: bigint;
}): Cell {
    const mode = params.mode ?? JobMode.FIXED;
    const applicationWindow = params.applicationWindow ?? 0;
    const hook = params.hookAddress ?? null;
    const master = params.jettonMaster ?? null;
    const hookGas = params.hookGas ?? 0n;
    const b = beginCell()
        .storeUint(mode, 8)
        .storeUint(applicationWindow, 32);
    if (hook) {
        b.storeBit(true).storeAddress(hook);
    } else {
        b.storeBit(false);
    }
    if (master) {
        b.storeBit(true).storeAddress(master);
    } else {
        b.storeBit(false);
    }
    b.storeCoins(hookGas);
    return b.endCell();
}

export class JettonJobFactory implements Contract {
    abi: ContractABI = { name: 'JettonJobFactory' };

    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new JettonJobFactory(address);
    }

    static createFromConfig(config: JettonJobFactoryConfig, code: Cell, workchain = 0) {
        const data = jettonJobFactoryConfigToCell(config);
        const init = { code, data };
        return new JettonJobFactory(contractAddress(workchain, init), init);
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
            jettonMaster?: Address | null;
            hookGas?: bigint;
        }
    ) {
        const v2 = buildJettonV2InitParams({
            mode: params.mode,
            applicationWindow: params.applicationWindow,
            hookAddress: params.hookAddress,
            jettonMaster: params.jettonMaster,
            hookGas: params.hookGas,
        });
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(JettonFactoryOpcodes.createJob, 32)
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
