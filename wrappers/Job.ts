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
    TupleItemInt,
} from '@ton/core';

// Opcodes are CRC-32 of the operation name. See contracts/job.tolk for
// the source strings; every value here is the output of
// Buffer.from("op::<name>", "utf-8") -> crc32 using the IEEE 802.3
// polynomial (the same one Tolk's "str".crc32() computes).
export const JobOpcodes = {
    fund: 0x7a90f051,            // CRC32("op::fund_job")
    takeJob: 0xba32c6d9,         // CRC32("op::take_job")
    submitResult: 0x493e737b,    // CRC32("op::submit_result")
    evaluate: 0xa478b965,        // CRC32("op::evaluate_job")
    cancel: 0x18261fbf,          // CRC32("op::cancel_job")
    initJob: 0xbb8c8df3,         // CRC32("op::init_job")
    claim: 0xa16c4dc0,           // CRC32("op::claim_job")
    quit: 0x710b6f59,            // CRC32("op::quit_job")
    setBudget: 0xb1e059fd,       // CRC32("op::set_budget")
    retryTransfer: 0xa7665d4e,   // CRC32("op::retry_transfer")
    commitSettlement: 0xe1f3102b,// CRC32("op::commit_settlement")
    emergencyReclaim: 0x2c31d1c3,// CRC32("op::emergency_reclaim")
};

// State constants matching job.tolk STATE_* values.
export const JobState = {
    OPEN: 0,
    FUNDED: 1,
    SUBMITTED: 2,
    COMPLETED: 3,
    DISPUTED: 4,
    CANCELLED: 5,
    SETTLING_COMPLETED: 6,
    SETTLING_DISPUTED: 7,
    SETTLING_CANCELLED: 8,
} as const;

export type JobConfig = {
    jobId: number;
    factoryAddress: Address;
};

export type JobData = {
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
};

export function jobConfigToCell(config: JobConfig): Cell {
    const emptyExt = beginCell()
        .storeUint(0, 32)  // timeout
        .storeUint(0, 32)  // createdAt
        .storeUint(0, 32)  // evaluationTimeout
        .storeUint(0, 32)  // submittedAt
        .storeUint(0, 8)   // resultType
        .storeUint(0, 256) // reason
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

export class Job implements Contract {
    abi: ContractABI = { name: 'Job' };

    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new Job(address);
    }

    static createFromConfig(config: JobConfig, code: Cell, workchain = 0) {
        const data = jobConfigToCell(config);
        const init = { code, data };
        return new Job(contractAddress(workchain, init), init);
    }

    // === Send methods ===

    async sendFund(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(JobOpcodes.fund, 32).endCell(),
        });
    }

    async sendTakeJob(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(JobOpcodes.takeJob, 32).endCell(),
        });
    }

    async sendSubmitResult(provider: ContractProvider, via: Sender, value: bigint, resultHash: bigint, resultType: number = 0) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(JobOpcodes.submitResult, 32)
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
                .storeUint(JobOpcodes.evaluate, 32)
                .storeUint(approved ? 1 : 0, 8)
                .storeUint(reason, 256)
                .endCell(),
        });
    }

    async sendCancel(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(JobOpcodes.cancel, 32).endCell(),
        });
    }

    async sendClaim(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(JobOpcodes.claim, 32).endCell(),
        });
    }

    async sendQuit(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(JobOpcodes.quit, 32).endCell(),
        });
    }

    async sendSetBudget(provider: ContractProvider, via: Sender, value: bigint, budget: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(JobOpcodes.setBudget, 32)
                .storeCoins(budget)
                .endCell(),
        });
    }

    // Recipient re-sends the payout while the contract is still SETTLING_*
    // (previous payout never landed). Callable by provider for SETTLING_COMPLETED
    // and by client for SETTLING_DISPUTED / SETTLING_CANCELLED.
    async sendRetryTransfer(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(JobOpcodes.retryTransfer, 32).endCell(),
        });
    }

    // Promote SETTLING_X → X once the payout has drained the contract.
    // Anyone can call this; it's the on-chain "mark as final" step.
    async sendCommitSettlement(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(JobOpcodes.commitSettlement, 32).endCell(),
        });
    }

    // Client-only escape hatch. After TIMEOUT_BYPASS (30 days) since job
    // creation, a job stuck in SETTLING can be force-closed by the client,
    // who receives any remaining funds. State becomes DISPUTED permanently.
    async sendEmergencyReclaim(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(JobOpcodes.emergencyReclaim, 32).endCell(),
        });
    }

    // === Getter methods ===

    async getJobData(provider: ContractProvider): Promise<JobData> {
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
        };
    }

    async getState(provider: ContractProvider): Promise<number> {
        const result = await provider.get('get_state', []);
        return result.stack.readNumber();
    }
}
