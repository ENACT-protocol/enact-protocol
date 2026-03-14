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
const ERR_JETTON_WALLET_NOT_SET: int = 108;

const MIN_STORAGE: int = 10000000;  // 0.01 TON reserve for storage fees

const OP_JETTON_TRANSFER: int = 0x0f8a7ea5;

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
//   resultType:uint8, reason:uint256,
//   jettonWallet:address

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

fun loadDetails(detailsCell: cell): (address, int, int, int, int, int, int, int, int, int, address) {
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
    val jettonWallet = es.loadAddress();

    return (evaluator, budget, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, reason, jettonWallet);
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
                     resultType: int, reason: int, jettonWallet: address): cell {
    val extCell = beginCell()
        .storeUint(timeout, 32)
        .storeUint(createdAt, 32)
        .storeUint(evalTimeout, 32)
        .storeUint(submittedAt, 32)
        .storeUint(resultType, 8)
        .storeUint(reason, 256)
        .storeAddress(jettonWallet)
        .endCell();

    return beginCell()
        .storeAddress(evaluator)
        .storeCoins(budget)
        .storeUint(descHash, 256)
        .storeUint(resultHash, 256)
        .storeRef(extCell)
        .endCell();
}

// ===================== JETTON TRANSFER HELPER =====================

fun sendJettonPayout(jw: address, jettonAmount: int, recipient: address, returnExcessTo: address) {
    val body = beginCell()
        .storeUint(OP_JETTON_TRANSFER, 32)
        .storeUint(0, 64)             // query_id
        .storeCoins(jettonAmount)     // Jetton amount
        .storeAddress(recipient)      // destination
        .storeAddress(returnExcessTo) // response_destination — TON excess from jetton transfer goes back to caller
        .storeBool(false)             // no custom_payload
        .storeCoins(50000000)         // forward_ton_amount = 0.05 TON
        .storeBool(false)             // no forward_payload
        .endCell();

    // First: return msg.value excess to caller (evaluator pays only ~0.003 gas)
    // Second: send jetton transfer using contract's full remaining balance
    reserveToncoinsOnBalance(MIN_STORAGE, RESERVE_MODE_AT_MOST);

    // Return incoming msg excess to caller
    createMessage({
        bounce: BounceMode.NoBounce,
        dest: returnExcessTo,
        value: 0,
        body: beginCell().endCell()
    }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_IGNORE_ERRORS);

    // Send jetton payout using contract's stored balance
    createMessage({
        bounce: BounceMode.Only256BitsOfBody,
        dest: jw,
        value: 0,
        body: body,
    }).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
}

// ===================== MESSAGES =====================

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

struct (0x0000000A) SetJettonWallet {
    jettonWallet: address;
}

struct (0x7362d09c) TransferNotification {
    queryId: uint64;
    amount: coins;
    sender: address;
}

type AllowedMessage =
    | TransferNotification
    | TakeJob
    | SubmitResult
    | EvaluateJob
    | CancelJob
    | InitJob
    | ClaimJob
    | QuitJob
    | SetBudget
    | SetJettonWallet

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
                0, msg.timeout, 0, msg.evaluationTimeout, 0, 0, 0, factory
            );
            saveData(msg.jobId, factory, msg.clientAddress, null, STATE_OPEN, det);

            // Return excess to client, keep MIN_STORAGE for rent
            reserveToncoinsOnBalance(MIN_STORAGE, RESERVE_MODE_AT_MOST);
            createMessage({
                bounce: BounceMode.NoBounce,
                dest: msg.clientAddress,
                value: 0,
                body: beginCell().endCell()
            }).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
        }

        SetJettonWallet => {
            val (jobId, factory, client, provider, state, detCell) = loadMainData();
            assert(state == STATE_OPEN) throw ERR_INVALID_STATE;
            assert(in.senderAddress == client) throw ERR_ACCESS_DENIED;

            val (evaluator, budget, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, reason, _) = loadDetails(detCell);
            val newDet = buildDetailsCell(evaluator, budget, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, reason, msg.jettonWallet);
            saveData(jobId, factory, client, provider, STATE_OPEN, newDet);

            // Return excess
            createMessage({
                bounce: BounceMode.NoBounce,
                dest: in.senderAddress,
                value: 0,
                body: beginCell().endCell()
            }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_IGNORE_ERRORS);
        }

        SetBudget => {
            val (jobId, factory, client, provider, state, detCell) = loadMainData();
            assert(state == STATE_OPEN) throw ERR_INVALID_STATE;
            assert(in.senderAddress == client) throw ERR_ACCESS_DENIED;

            val (evaluator, _, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, reason, jettonWallet) = loadDetails(detCell);
            val newDet = buildDetailsCell(evaluator, msg.budget, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, reason, jettonWallet);
            saveData(jobId, factory, client, provider, STATE_OPEN, newDet);

            // Return excess
            createMessage({
                bounce: BounceMode.NoBounce,
                dest: in.senderAddress,
                value: 0,
                body: beginCell().endCell()
            }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_IGNORE_ERRORS);
        }

        TransferNotification => {
            val (jobId, factory, client, provider, state, detCell) = loadMainData();
            assert(state == STATE_OPEN) throw ERR_INVALID_STATE;

            val (evaluator, budget, descHash, resultHash, timeout, _, evalTimeout, submittedAt, resultType, reason, jettonWallet) = loadDetails(detCell);
            assert(in.senderAddress == jettonWallet) throw ERR_ACCESS_DENIED;
            assert(jettonWallet != factory) throw ERR_JETTON_WALLET_NOT_SET;
            assert(budget > 0) throw ERR_BUDGET_NOT_SET;
            assert(msg.amount >= budget) throw ERR_INSUFFICIENT_FUNDS;
            assert(msg.sender == client) throw ERR_ACCESS_DENIED;

            val newDet = buildDetailsCell(evaluator, budget, descHash, resultHash, timeout, blockchain.now(), evalTimeout, submittedAt, resultType, reason, jettonWallet);
            saveData(jobId, factory, client, provider, STATE_FUNDED, newDet);
        }

        TakeJob => {
            val (jobId, factory, client, provider, state, det) = loadMainData();
            assert(state == STATE_FUNDED) throw ERR_INVALID_STATE;
            assert(provider == null) throw ERR_ALREADY_HAS_PROVIDER;

            saveData(jobId, factory, client, in.senderAddress, STATE_FUNDED, det);

            // Return excess
            createMessage({
                bounce: BounceMode.NoBounce,
                dest: in.senderAddress,
                value: 0,
                body: beginCell().endCell()
            }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_IGNORE_ERRORS);
        }

        QuitJob => {
            val (jobId, factory, client, provider, state, det) = loadMainData();
            assert(state == STATE_FUNDED) throw ERR_INVALID_STATE;
            assert(provider != null) throw ERR_NO_PROVIDER;
            assert(in.senderAddress == provider!) throw ERR_ACCESS_DENIED;

            saveData(jobId, factory, client, null, STATE_FUNDED, det);

            // Return excess
            createMessage({
                bounce: BounceMode.NoBounce,
                dest: in.senderAddress,
                value: 0,
                body: beginCell().endCell()
            }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_IGNORE_ERRORS);
        }

        SubmitResult => {
            val (jobId, factory, client, provider, state, detCell) = loadMainData();
            assert(state == STATE_FUNDED) throw ERR_INVALID_STATE;
            assert(provider != null) throw ERR_NO_PROVIDER;
            assert(in.senderAddress == provider!) throw ERR_ACCESS_DENIED;

            val (evaluator, budget, descHash, _, timeout, createdAt, evalTimeout, _, _, reason, jettonWallet) = loadDetails(detCell);
            val newDet = buildDetailsCell(evaluator, budget, descHash, msg.resultHash, timeout, createdAt, evalTimeout, blockchain.now(), msg.resultType, reason, jettonWallet);
            saveData(jobId, factory, client, provider, STATE_SUBMITTED, newDet);

            // Return excess
            createMessage({
                bounce: BounceMode.NoBounce,
                dest: in.senderAddress,
                value: 0,
                body: beginCell().endCell()
            }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_IGNORE_ERRORS);
        }

        EvaluateJob => {
            val (jobId, factory, client, provider, state, detCell) = loadMainData();
            assert(state == STATE_SUBMITTED) throw ERR_INVALID_STATE;
            val (evaluator, budget, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, _, jettonWallet) = loadDetails(detCell);
            assert(in.senderAddress == evaluator) throw ERR_ACCESS_DENIED;

            val newDet = buildDetailsCell(evaluator, budget, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, msg.reason, jettonWallet);

            if (msg.approved != 0) {
                saveData(jobId, factory, client, provider, STATE_COMPLETED, newDet);
                sendJettonPayout(jettonWallet, budget, provider!, evaluator);
            } else {
                saveData(jobId, factory, client, provider, STATE_DISPUTED, newDet);
                sendJettonPayout(jettonWallet, budget, client, evaluator);
            }
        }

        ClaimJob => {
            val (jobId, factory, client, provider, state, detCell) = loadMainData();
            assert(state == STATE_SUBMITTED) throw ERR_INVALID_STATE;
            assert(provider != null) throw ERR_NO_PROVIDER;
            assert(in.senderAddress == provider!) throw ERR_ACCESS_DENIED;

            val (_, budget, _, _, _, _, evalTimeout, submittedAt, _, _, jettonWallet) = loadDetails(detCell);
            val evalDeadline = submittedAt + evalTimeout;
            assert(blockchain.now() >= evalDeadline) throw ERR_EVAL_TIMEOUT_NOT_EXPIRED;

            saveData(jobId, factory, client, provider, STATE_COMPLETED, detCell);
            sendJettonPayout(jettonWallet, budget, provider!, provider!);
        }

        CancelJob => {
            val (jobId, factory, client, provider, state, detCell) = loadMainData();
            assert(in.senderAddress == client) throw ERR_ACCESS_DENIED;
            assert(state == STATE_FUNDED) throw ERR_INVALID_STATE;

            val (_, budget, _, _, timeout, createdAt, _, _, _, _, jettonWallet) = loadDetails(detCell);
            val deadline = createdAt + timeout;
            assert(blockchain.now() >= deadline) throw ERR_TIMEOUT_NOT_EXPIRED;

            saveData(jobId, factory, client, provider, STATE_CANCELLED, detCell);
            sendJettonPayout(jettonWallet, budget, client, client);
        }

        else => {
            assert(in.body.isEmpty()) throw 0xFFFF;
        }
    }
}

// ===================== BOUNCE HANDLER =====================

fun onBouncedMessage(in: InMessageBounced) {
    // Accept bounced jetton transfers — funds return to contract for manual recovery
}

// ===================== GETTERS =====================

get fun get_job_data(): (int, address, address?, address, int, int, int, int, int, int, int, int, int, int, address) {
    val (jobId, _, client, provider, state, detCell) = loadMainData();
    val (evaluator, budget, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, reason, jettonWallet) = loadDetails(detCell);
    return (jobId, client, provider, evaluator, budget, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, reason, state, jettonWallet);
}

get fun get_state(): int {
    val (_, _, _, _, state, _) = loadMainData();
    return state;
}
