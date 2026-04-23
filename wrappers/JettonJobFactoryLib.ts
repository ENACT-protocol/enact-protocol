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

import { buildJettonV2InitParams, JettonFactoryOpcodes, JobMode } from './JettonJobFactory';

export { JettonFactoryOpcodes, JobMode, buildJettonV2InitParams };

export type JettonJobFactoryLibConfig = {
    owner: Address;
    jobCodeHash: Buffer;
};

export function jettonJobFactoryLibConfigToCell(config: JettonJobFactoryLibConfig): Cell {
    if (config.jobCodeHash.length !== 32) {
        throw new Error('jobCodeHash must be 32 bytes');
    }
    return beginCell()
        .storeAddress(config.owner)
        .storeBuffer(config.jobCodeHash)
        .storeUint(0, 32)
        .endCell();
}

export class JettonJobFactoryLib implements Contract {
    abi: ContractABI = { name: 'JettonJobFactoryLib' };

    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new JettonJobFactoryLib(address);
    }

    static createFromConfig(config: JettonJobFactoryLibConfig, code: Cell, workchain = 0) {
        const data = jettonJobFactoryLibConfigToCell(config);
        const init = { code, data };
        return new JettonJobFactoryLib(contractAddress(workchain, init), init);
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
        },
    ) {
        const v2 = buildJettonV2InitParams({
            mode: params.mode,
            applicationWindow: params.applicationWindow,
            hookAddress: params.hookAddress,
            jettonMaster: params.jettonMaster,
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
