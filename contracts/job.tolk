tolk 1.2

import "@stdlib/gas-payments"

// ===================== CONSTANTS =====================

const STATE_OPEN: int = 0;
const STATE_FUNDED: int = 1;
const STATE_SUBMITTED: int = 2;
const STATE_COMPLETED: int = 3;
const STATE_DISPUTED: int = 4;
const STATE_CANCELLED: int = 5;

const ERR_ACCESS_DENIED: int = 100;
const ERR_INVALID_STATE: int = 101;
const ERR_TIMEOUT_NOT_EXPIRED: int = 102;
const ERR_ALREADY_HAS_PROVIDER: int = 103;
const ERR_INSUFFICIENT_FUNDS: int = 104;
const ERR_EVAL_TIMEOUT_NOT_EXPIRED: int = 105;
const ERR_BUDGET_NOT_SET: int = 106;
const ERR_NO_PROVIDER: int = 107;

// ===================== STORAGE LAYOUT =====================
// Main cell:
//   jobId:uint32, factoryAddr:address, clientAddr:address,
//   hasProvider:bool, [providerAddr:address if hasProvider],
//   state:uint8
//   ref → details cell
//
// Details cell:
//   evaluatorAddr:address, budget:coins,
//   descHash:uint256, resultHash:uint256
//   ref → ext cell
//
// Ext cell:
//   timeout:uint32, createdAt:uint32,
//   evalTimeout:uint32, submittedAt:uint32,
//   resultType:uint8, reason:uint256

fun loadMainData(): (int, address, address, address?, int, cell) {
    var cs = contract.getData().beginParse();
    val jobId = cs.loadUint(32);
    val factory = cs.loadAddress();
    val client = cs.loadAddress();
    val hasProvider = cs.loadBool();
    var provider: address? = null;
    if (hasProvider) {
        provider = cs.loadAddress();
    }
    val state = cs.loadUint(8);
    val detailsCell = cs.loadRef();
    return (jobId, factory, client, provider, state, detailsCell);
}

fun loadDetails(detailsCell: cell): (address, int, int, int, int, int, int, int, int, int) {
    var ds = detailsCell.beginParse();
    val evaluator = ds.loadAddress();
    val budget = ds.loadCoins();
    val descHash = ds.loadUint(256);
    val resultHash = ds.loadUint(256);
    val extCell = ds.loadRef();

    var es = extCell.beginParse();
    val timeout = es.loadUint(32);
    val createdAt = es.loadUint(32);
    val evalTimeout = es.loadUint(32);
    val submittedAt = es.loadUint(32);
    val resultType = es.loadUint(8);
    val reason = es.loadUint(256);

    return (evaluator, budget, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, reason);
}

fun saveData(jobId: int, factory: address, client: address, provider: address?, state: int, detailsCell: cell) {
    var b = beginCell()
        .storeUint(jobId, 32)
        .storeAddress(factory)
        .storeAddress(client);
    if (provider != null) {
        b.storeBool(true).storeAddress(provider!);
    } else {
        b.storeBool(false);
    }
    b.storeUint(state, 8)
     .storeRef(detailsCell);
    contract.setData(b.endCell());
}

fun buildDetailsCell(evaluator: address, budget: int, descHash: int, resultHash: int,
                     timeout: int, createdAt: int, evalTimeout: int, submittedAt: int,
                     resultType: int, reason: int): cell {
    val extCell = beginCell()
        .storeUint(timeout, 32)
        .storeUint(createdAt, 32)
        .storeUint(evalTimeout, 32)
        .storeUint(submittedAt, 32)
        .storeUint(resultType, 8)
        .storeUint(reason, 256)
        .endCell();

    return beginCell()
        .storeAddress(evaluator)
        .storeCoins(budget)
        .storeUint(descHash, 256)
        .storeUint(resultHash, 256)
        .storeRef(extCell)
        .endCell();
}

// ===================== MESSAGES =====================

struct (0x00000001) FundJob {}

struct (0x00000002) TakeJob {}

struct (0x00000003) SubmitResult {
    resultHash: uint256;
    resultType: uint8;
}

struct (0x00000004) EvaluateJob {
    approved: uint8;
    reason: uint256;
}

struct (0x00000005) CancelJob {}

@overflow1023_policy("suppress")
struct (0x00000006) InitJob {
    jobId: uint32;
    clientAddress: address;
    evaluatorAddress: address;
    budget: coins;
    descriptionHash: uint256;
    timeout: uint32;
    evaluationTimeout: uint32;
}

struct (0x00000007) ClaimJob {}

struct (0x00000008) QuitJob {}

struct (0x00000009) SetBudget {
    budget: coins;
}

type AllowedMessage =
    | FundJob
    | TakeJob
    | SubmitResult
    | EvaluateJob
    | CancelJob
    | InitJob
    | ClaimJob
    | QuitJob
    | SetBudget

// ===================== HANDLER =====================

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessage.fromSlice(in.body);

    match (msg) {
        InitJob => {
            val (_, factory, _, _, state, _) = loadMainData();
            assert(in.senderAddress == factory) throw ERR_ACCESS_DENIED;
            assert(state == STATE_OPEN) throw ERR_INVALID_STATE;

            val det = buildDetailsCell(
                msg.evaluatorAddress, msg.budget, msg.descriptionHash,
                0, msg.timeout, 0, msg.evaluationTimeout, 0, 0, 0
            );
            saveData(msg.jobId, factory, msg.clientAddress, null, STATE_OPEN, det);
        }

        SetBudget => {
            val (jobId, factory, client, provider, state, detCell) = loadMainData();
            assert(state == STATE_OPEN) throw ERR_INVALID_STATE;
            assert(in.senderAddress == client) throw ERR_ACCESS_DENIED;

            val (evaluator, _, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, reason) = loadDetails(detCell);
            val newDet = buildDetailsCell(evaluator, msg.budget, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, reason);
            saveData(jobId, factory, client, provider, STATE_OPEN, newDet);
        }

        FundJob => {
            val (jobId, factory, client, provider, state, detCell) = loadMainData();
            assert(in.senderAddress == client) throw ERR_ACCESS_DENIED;
            assert(state == STATE_OPEN) throw ERR_INVALID_STATE;

            val (evaluator, budget, descHash, resultHash, timeout, _, evalTimeout, submittedAt, resultType, reason) = loadDetails(detCell);
            assert(budget > 0) throw ERR_BUDGET_NOT_SET;
            assert(in.valueCoins >= budget) throw ERR_INSUFFICIENT_FUNDS;

            val newDet = buildDetailsCell(evaluator, budget, descHash, resultHash, timeout, blockchain.now(), evalTimeout, submittedAt, resultType, reason);
            saveData(jobId, factory, client, provider, STATE_FUNDED, newDet);
        }

        TakeJob => {
            val (jobId, factory, client, provider, state, det) = loadMainData();
            assert(state == STATE_FUNDED) throw ERR_INVALID_STATE;
            assert(provider == null) throw ERR_ALREADY_HAS_PROVIDER;

            saveData(jobId, factory, client, in.senderAddress, STATE_FUNDED, det);
        }

        QuitJob => {
            val (jobId, factory, client, provider, state, det) = loadMainData();
            assert(state == STATE_FUNDED) throw ERR_INVALID_STATE;
            assert(provider != null) throw ERR_NO_PROVIDER;
            assert(in.senderAddress == provider!) throw ERR_ACCESS_DENIED;

            saveData(jobId, factory, client, null, STATE_FUNDED, det);
        }

        SubmitResult => {
            val (jobId, factory, client, provider, state, detCell) = loadMainData();
            assert(state == STATE_FUNDED) throw ERR_INVALID_STATE;
            assert(provider != null) throw ERR_NO_PROVIDER;
            assert(in.senderAddress == provider!) throw ERR_ACCESS_DENIED;

            val (evaluator, budget, descHash, _, timeout, createdAt, evalTimeout, _, _, reason) = loadDetails(detCell);
            val newDet = buildDetailsCell(evaluator, budget, descHash, msg.resultHash, timeout, createdAt, evalTimeout, blockchain.now(), msg.resultType, reason);
            saveData(jobId, factory, client, provider, STATE_SUBMITTED, newDet);
        }

        EvaluateJob => {
            val (jobId, factory, client, provider, state, detCell) = loadMainData();
            assert(state == STATE_SUBMITTED) throw ERR_INVALID_STATE;
            val (evaluator, budget, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, _) = loadDetails(detCell);
            assert(in.senderAddress == evaluator) throw ERR_ACCESS_DENIED;

            val newDet = buildDetailsCell(evaluator, budget, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, msg.reason);

            if (msg.approved != 0) {
                saveData(jobId, factory, client, provider, STATE_COMPLETED, newDet);
                createMessage({
                    bounce: BounceMode.Only256BitsOfBody,
                    dest: provider!,
                    value: 0,
                    body: beginCell().endCell()
                }).send(SEND_MODE_CARRY_ALL_BALANCE);
            } else {
                saveData(jobId, factory, client, provider, STATE_DISPUTED, newDet);
                createMessage({
                    bounce: BounceMode.Only256BitsOfBody,
                    dest: client,
                    value: 0,
                    body: beginCell().endCell()
                }).send(SEND_MODE_CARRY_ALL_BALANCE);
            }
        }

        ClaimJob => {
            val (jobId, factory, client, provider, state, detCell) = loadMainData();
            assert(state == STATE_SUBMITTED) throw ERR_INVALID_STATE;
            assert(provider != null) throw ERR_NO_PROVIDER;
            assert(in.senderAddress == provider!) throw ERR_ACCESS_DENIED;

            val (_, _, _, _, _, _, evalTimeout, submittedAt, _, _) = loadDetails(detCell);
            val evalDeadline = submittedAt + evalTimeout;
            assert(blockchain.now() >= evalDeadline) throw ERR_EVAL_TIMEOUT_NOT_EXPIRED;

            saveData(jobId, factory, client, provider, STATE_COMPLETED, detCell);
            createMessage({
                bounce: BounceMode.Only256BitsOfBody,
                dest: provider!,
                value: 0,
                body: beginCell().endCell()
            }).send(SEND_MODE_CARRY_ALL_BALANCE);
        }

        CancelJob => {
            val (jobId, factory, client, provider, state, detCell) = loadMainData();
            assert(in.senderAddress == client) throw ERR_ACCESS_DENIED;
            assert(state == STATE_FUNDED) throw ERR_INVALID_STATE;

            val (_, _, _, _, timeout, createdAt, _, _, _, _) = loadDetails(detCell);
            val deadline = createdAt + timeout;
            assert(blockchain.now() >= deadline) throw ERR_TIMEOUT_NOT_EXPIRED;

            saveData(jobId, factory, client, provider, STATE_CANCELLED, detCell);
            createMessage({
                bounce: BounceMode.Only256BitsOfBody,
                dest: client,
                value: 0,
                body: beginCell().endCell()
            }).send(SEND_MODE_CARRY_ALL_BALANCE);
        }

        else => {
            assert(in.body.isEmpty()) throw 0xFFFF;
        }
    }
}

// ===================== BOUNCE HANDLER =====================

fun onBouncedMessage(in: InMessageBounced) {
    // Accept bounced payouts — funds return to contract for manual recovery
}

// ===================== GETTERS =====================

get fun get_job_data(): (int, address, address?, address, int, int, int, int, int, int, int, int, int, int) {
    val (jobId, _, client, provider, state, detCell) = loadMainData();
    val (evaluator, budget, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, reason) = loadDetails(detCell);
    return (jobId, client, provider, evaluator, budget, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, reason, state);
}

get fun get_state(): int {
    val (_, _, _, _, state, _) = loadMainData();
    return state;
}
