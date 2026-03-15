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

export const JettonJobOpcodes = {
    takeJob: 0x00000002,
    submitResult: 0x00000003,
    evaluate: 0x00000004,
    cancel: 0x00000005,
    initJob: 0x00000006,
    claim: 0x00000007,
    quit: 0x00000008,
    setBudget: 0x00000009,
    setJettonWallet: 0x0000000a,
    transferNotification: 0x7362d09c,
};

export type JettonJobConfig = {
    jobId: number;
    factoryAddress: Address;
};

export type JettonJobData = {
    jobId: number;
    clientAddress: Address;
    providerAddress: Address | null;
    evaluatorAddress: Address;
    budget: bigint;
    descriptionHash: bigint;
    resultHash: bigint;
    timeout: number;
    createdAt: number;
    evaluationTimeout: number;
    submittedAt: number;
    resultType: number;
    reason: bigint;
    state: number;
    jettonWallet: Address;
};

export function jettonJobConfigToCell(config: JettonJobConfig): Cell {
    const emptyExt = beginCell()
        .storeUint(0, 32)  // timeout
        .storeUint(0, 32)  // createdAt
        .storeUint(0, 32)  // evaluationTimeout
        .storeUint(0, 32)  // submittedAt
        .storeUint(0, 8)   // resultType
        .storeUint(0, 256) // reason
        .storeAddress(config.factoryAddress) // jettonWallet placeholder
        .endCell();

    const emptyDetails = beginCell()
        .storeAddress(config.factoryAddress) // evaluator placeholder
        .storeCoins(0n)
        .storeUint(0, 256) // descriptionHash
        .storeUint(0, 256) // resultHash
        .storeRef(emptyExt)
        .endCell();

    return beginCell()
        .storeUint(config.jobId, 32)
        .storeAddress(config.factoryAddress)
        .storeAddress(config.factoryAddress) // client placeholder
        .storeBit(false) // hasProvider = false
        .storeUint(0, 8) // state = OPEN
        .storeRef(emptyDetails)
        .endCell();
}

export class JettonJob implements Contract {
    abi: ContractABI = { name: 'JettonJob' };

    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new JettonJob(address);
    }

    static createFromConfig(config: JettonJobConfig, code: Cell, workchain = 0) {
        const data = jettonJobConfigToCell(config);
        const init = { code, data };
        return new JettonJob(contractAddress(workchain, init), init);
    }

    // === Send methods ===

    async sendSetJettonWallet(provider: ContractProvider, via: Sender, value: bigint, jettonWallet: Address) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(JettonJobOpcodes.setJettonWallet, 32)
                .storeAddress(jettonWallet)
                .endCell(),
        });
    }

    async sendTransferNotification(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        params: { queryId?: number; amount: bigint; sender: Address }
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(JettonJobOpcodes.transferNotification, 32)
                .storeUint(params.queryId ?? 0, 64)
                .storeCoins(params.amount)
                .storeAddress(params.sender)
                .storeBit(false) // empty forward_payload (inline)
                .endCell(),
        });
    }

    async sendTakeJob(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(JettonJobOpcodes.takeJob, 32).endCell(),
        });
    }

    async sendSubmitResult(provider: ContractProvider, via: Sender, value: bigint, resultHash: bigint, resultType: number = 0) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(JettonJobOpcodes.submitResult, 32)
                .storeUint(resultHash, 256)
                .storeUint(resultType, 8)
                .endCell(),
        });
    }

    async sendEvaluate(provider: ContractProvider, via: Sender, value: bigint, approved: boolean, reason: bigint = 0n) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(JettonJobOpcodes.evaluate, 32)
                .storeUint(approved ? 1 : 0, 8)
                .storeUint(reason, 256)
                .endCell(),
        });
    }

    async sendCancel(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(JettonJobOpcodes.cancel, 32).endCell(),
        });
    }

    async sendClaim(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(JettonJobOpcodes.claim, 32).endCell(),
        });
    }

    async sendQuit(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(JettonJobOpcodes.quit, 32).endCell(),
        });
    }

    async sendSetBudget(provider: ContractProvider, via: Sender, value: bigint, budget: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(JettonJobOpcodes.setBudget, 32)
                .storeCoins(budget)
                .endCell(),
        });
    }

    // === Getter methods ===

    async getJobData(provider: ContractProvider): Promise<JettonJobData> {
        const result = await provider.get('get_job_data', []);
        const stack = result.stack;

        return {
            jobId: stack.readNumber(),
            clientAddress: stack.readAddress(),
            providerAddress: stack.readAddressOpt(),
            evaluatorAddress: stack.readAddress(),
            budget: stack.readBigNumber(),
            descriptionHash: stack.readBigNumber(),
            resultHash: stack.readBigNumber(),
            timeout: stack.readNumber(),
            createdAt: stack.readNumber(),
            evaluationTimeout: stack.readNumber(),
            submittedAt: stack.readNumber(),
            resultType: stack.readNumber(),
            reason: stack.readBigNumber(),
            state: stack.readNumber(),
            jettonWallet: stack.readAddress(),
        };
    }

    async getState(provider: ContractProvider): Promise<number> {
        const result = await provider.get('get_state', []);
        return result.stack.readNumber();
    }
}
