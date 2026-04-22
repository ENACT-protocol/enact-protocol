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
import { sign } from '@ton/crypto';

// Opcodes are CRC-32 of the operation name (see contracts/jetton_job.tolk).
// The only non-hashed value is `transferNotification`, which is the
// TEP-74 well-known tag for jetton transfer notifications.
export const JettonJobOpcodes = {
    takeJob: 0xba32c6d9,         // CRC32("op::take_job")
    submitResult: 0x493e737b,    // CRC32("op::submit_result")
    evaluate: 0xa478b965,        // CRC32("op::evaluate_job")
    cancel: 0x18261fbf,          // CRC32("op::cancel_job")
    initJob: 0xbb8c8df3,         // CRC32("op::init_job")
    claim: 0xa16c4dc0,           // CRC32("op::claim_job")
    quit: 0x710b6f59,            // CRC32("op::quit_job")
    setBudget: 0xb1e059fd,       // CRC32("op::set_budget")
    setJettonWallet: 0x6a48fe56, // CRC32("op::set_jetton_wallet")
    acceptProvider: 0x663a16f6,  // CRC32("op::accept_provider")
    extendWindow: 0x16b321c2,    // CRC32("op::extend_window")
    retryTransfer: 0xa7665d4e,   // CRC32("op::retry_transfer")
    commitSettlement: 0xe1f3102b,// CRC32("op::commit_settlement")
    emergencyReclaim: 0x2c31d1c3,// CRC32("op::emergency_reclaim")
    transferNotification: 0x7362d09c, // TEP-74 standard
};

export const HookOpcodes = {
    afterEvaluate: 0x6f0e4a7c,   // CRC32("notify::after_evaluate")
};

// State constants matching jetton_job.tolk STATE_* values.
export const JettonJobState = {
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

export const JobMode = {
    FIXED: 0,
    APPLICATION: 1,
} as const;

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

export type JettonJobV2Data = {
    mode: number;
    applicationDeadline: number;
    hookAddress: Address | null;
    jettonMaster: Address | null;
    pendingBudget: bigint;
};

export function jettonJobConfigToCell(config: JettonJobConfig): Cell {
    // Mirror the factory's calcJobStateInit. v2 adds jettonMaster and
    // pendingBudget to the jetton v2 ref — must match exactly or the
    // deterministic address will shift and deploys will fail.
    const emptyV2 = beginCell()
        .storeUint(0, 8)  // mode = MODE_FIXED (placeholder)
        .storeUint(0, 32) // applicationDeadline
        .storeBit(false)  // no hookAddress
        .storeBit(false)  // no jettonMaster
        .storeCoins(0n)   // pendingBudget
        .endCell();

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
        .storeRef(emptyV2)
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

export function buildBidSignaturePayload(params: {
    jobAddress: Address;
    proposedBudget: bigint;
    providerAddress: Address;
}): Cell {
    return beginCell()
        .storeAddress(params.jobAddress)
        .storeCoins(params.proposedBudget)
        .storeAddress(params.providerAddress)
        .endCell();
}

export function signBid(
    params: {
        jobAddress: Address;
        proposedBudget: bigint;
        providerAddress: Address;
    },
    providerSecretKey: Buffer,
): Buffer {
    const payload = buildBidSignaturePayload(params);
    return sign(payload.hash(), providerSecretKey);
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

    // v2: in FUNDED state, SetBudget stages a pending top-up. The client
    // then sends a TransferNotification carrying `newBudget - currentBudget`
    // jettons, which promotes `budget` to the new value.
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

    async sendAcceptProvider(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        params: {
            providerAddress: Address;
            proposedBudget: bigint;
            providerPubkey: Buffer;
            signature: Buffer;
        }
    ) {
        if (params.providerPubkey.length !== 32) {
            throw new Error('providerPubkey must be 32 bytes');
        }
        if (params.signature.length !== 64) {
            throw new Error('signature must be 64 bytes');
        }
        const sigRef = beginCell().storeBuffer(params.signature).endCell();
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(JettonJobOpcodes.acceptProvider, 32)
                .storeAddress(params.providerAddress)
                .storeCoins(params.proposedBudget)
                .storeUint(BigInt('0x' + params.providerPubkey.toString('hex')), 256)
                .storeRef(sigRef)
                .endCell(),
        });
    }

    async sendExtendWindow(provider: ContractProvider, via: Sender, value: bigint, newDeadline: number) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(JettonJobOpcodes.extendWindow, 32)
                .storeUint(newDeadline, 32)
                .endCell(),
        });
    }

    async sendRetryTransfer(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(JettonJobOpcodes.retryTransfer, 32).endCell(),
        });
    }

    async sendCommitSettlement(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(JettonJobOpcodes.commitSettlement, 32).endCell(),
        });
    }

    async sendEmergencyReclaim(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(JettonJobOpcodes.emergencyReclaim, 32).endCell(),
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

    async getV2Data(provider: ContractProvider): Promise<JettonJobV2Data> {
        const result = await provider.get('get_v2_data', []);
        const stack = result.stack;
        return {
            mode: stack.readNumber(),
            applicationDeadline: stack.readNumber(),
            hookAddress: stack.readAddressOpt(),
            jettonMaster: stack.readAddressOpt(),
            pendingBudget: stack.readBigNumber(),
        };
    }

    async getState(provider: ContractProvider): Promise<number> {
        const result = await provider.get('get_state', []);
        return result.stack.readNumber();
    }
}
