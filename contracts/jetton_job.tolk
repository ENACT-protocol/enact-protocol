tolk 1.3

import "@stdlib/gas-payments"

// ===================== CONSTANTS =====================

const STATE_OPEN: int = 0;
const STATE_FUNDED: int = 1;
const STATE_SUBMITTED: int = 2;
const STATE_COMPLETED: int = 3;
const STATE_DISPUTED: int = 4;
const STATE_CANCELLED: int = 5;
// Intermediate "parking orbit" states — jetton payout in flight. See BUG-1
// two-phase settlement design. The jetton contract variant cannot prove
// drain on-chain (jettons live on a separate jetton wallet), so commit is
// recipient-only here (vs. anyone-with-balance-check in job.tolk).
const STATE_SETTLING_COMPLETED: int = 6;
const STATE_SETTLING_DISPUTED: int = 7;
const STATE_SETTLING_CANCELLED: int = 8;

const ERR_ACCESS_DENIED: int = 100;
const ERR_INVALID_STATE: int = 101;
const ERR_TIMEOUT_NOT_EXPIRED: int = 102;
const ERR_ALREADY_HAS_PROVIDER: int = 103;
const ERR_INSUFFICIENT_FUNDS: int = 104;
const ERR_EVAL_TIMEOUT_NOT_EXPIRED: int = 105;
const ERR_BUDGET_NOT_SET: int = 106;
const ERR_NO_PROVIDER: int = 107;
const ERR_JETTON_WALLET_NOT_SET: int = 108;
const ERR_BYPASS_NOT_ALLOWED: int = 110;

const MIN_STORAGE: int = 5000000;   // 0.005 TON reserve for storage fees
// Emergency escape hatch: after this duration in SETTLING, the client can
// pull remaining funds regardless of the configured recipient. Prevents any
// scenario where a permanently unreachable recipient locks a job forever.
const TIMEOUT_BYPASS: int = 2592000;  // 30 days

// Per-opcode minimum gas requirements. Jetton payouts need more TON
// than plain-TON payouts because sendJettonPayout forwards 0.02 TON
// downstream plus covers the jetton wallet's own compute/forward fees.
// Floor lowered from 0.15 -> 0.12 to match the reduced forward amount.
const MIN_GAS_JETTON_PAYOUT: int = 120000000;  // 0.12 TON for ops that fire a jetton transfer
const MIN_GAS_STATE_CHANGE: int = 30000000;    // 0.03 TON for simple state transitions

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
        .storeAddress(returnExcessTo) // response_destination — ALL excess TON goes back to caller
        .storeBool(false)             // no custom_payload
        // forward_ton_amount = 0.02 TON. A TEP-74 transfer_notification
        // to a standard wallet consumes ~0.005 TON of gas; 0.02 TON
        // gives a 4x safety margin and saves 0.03 TON per payout
        // compared to the previous 0.05 TON default.
        .storeCoins(20000000)
        .storeBool(false)             // no forward_payload
        .endCell();

    // Send entire contract balance with jetton transfer.
    // Evaluator's msg.value excess + contract's stored balance all go to jetton wallet.
    // Jetton wallet returns unused TON to response_destination (= returnExcessTo).
    reserveToncoinsOnBalance(MIN_STORAGE, RESERVE_MODE_AT_MOST);
    createMessage({
        bounce: BounceMode.Only256BitsOfBody,
        dest: jw,
        value: 0,
        body: body,
    }).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
}

// ===================== MESSAGES =====================

// CRC-32 opcodes: same scheme as job.tolk. See that file for rationale.

// 0xba32c6d9 = CRC32("op::take_job")
struct (0xba32c6d9) TakeJob {}

// 0x493e737b = CRC32("op::submit_result")
struct (0x493e737b) SubmitResult {
    resultHash: uint256;
    resultType: uint8;
}

// 0xa478b965 = CRC32("op::evaluate_job")
struct (0xa478b965) EvaluateJob {
    approved: uint8;
    reason: uint256;
}

// 0x18261fbf = CRC32("op::cancel_job")
struct (0x18261fbf) CancelJob {}

// 0xbb8c8df3 = CRC32("op::init_job")
@overflow1023_policy("suppress")
struct (0xbb8c8df3) InitJob {
    jobId: uint32;
    clientAddress: address;
    evaluatorAddress: address;
    budget: coins;
    descriptionHash: uint256;
    timeout: uint32;
    evaluationTimeout: uint32;
}

// 0xa16c4dc0 = CRC32("op::claim_job")
struct (0xa16c4dc0) ClaimJob {}

// 0x710b6f59 = CRC32("op::quit_job")
struct (0x710b6f59) QuitJob {}

// 0xb1e059fd = CRC32("op::set_budget")
struct (0xb1e059fd) SetBudget {
    budget: coins;
}

// 0x6a48fe56 = CRC32("op::set_jetton_wallet")
struct (0x6a48fe56) SetJettonWallet {
    jettonWallet: address;
}

// ---------- Two-phase settlement opcodes ----------
// 0xa7665d4e = CRC32("op::retry_transfer")
struct (0xa7665d4e) RetryTransfer {}

// 0xe1f3102b = CRC32("op::commit_settlement")
struct (0xe1f3102b) CommitSettlement {}

// 0x2c31d1c3 = CRC32("op::emergency_reclaim")
struct (0x2c31d1c3) EmergencyReclaim {}

// TEP-74 standard transfer_notification opcode, CRC-32 of the TL-B line
// (not of the short name). Left unchanged so third-party jetton wallets
// that comply with TEP-74 keep delivering funding notifications to us.
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
    | RetryTransfer
    | CommitSettlement
    | EmergencyReclaim

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
            assert(in.valueCoins >= MIN_GAS_STATE_CHANGE) throw ERR_INSUFFICIENT_FUNDS;
            val (jobId, factory, client, provider, state, detCell) = loadMainData();
            assert(state == STATE_OPEN) throw ERR_INVALID_STATE;
            assert(in.senderAddress == client) throw ERR_ACCESS_DENIED;

            val (evaluator, budget, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, reason, currentWallet) = loadDetails(detCell);
            // Disallow a second SetJettonWallet. InitJob stores the factory
            // address as a sentinel placeholder, so a real jetton wallet
            // has been installed iff currentWallet != factory. If the
            // client sent USDT to the wrong wallet already, changing the
            // wallet here would strand those jettons on the old one —
            // cleaner to require them to cancel the job (now possible in
            // STATE_OPEN after the earlier fix) and recreate.
            assert(currentWallet == factory) throw ERR_INVALID_STATE;

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
            assert(in.valueCoins >= MIN_GAS_STATE_CHANGE) throw ERR_INSUFFICIENT_FUNDS;
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
            // Exact match required. Accepting >= budget would leave the
            // overpaid delta stranded on the job's jetton wallet with no
            // built-in way to withdraw it — CARRY_ALL_BALANCE on payout
            // only delivers the stored `budget`. SDK/UI clients must
            // send exactly budget; overpayment is a caller bug we reject
            // before state mutates.
            assert(msg.amount == budget) throw ERR_INSUFFICIENT_FUNDS;
            assert(msg.sender == client) throw ERR_ACCESS_DENIED;

            val newDet = buildDetailsCell(evaluator, budget, descHash, resultHash, timeout, blockchain.now(), evalTimeout, submittedAt, resultType, reason, jettonWallet);
            saveData(jobId, factory, client, provider, STATE_FUNDED, newDet);

            // Return the forward-TON excess (what the jetton wallet
            // forwarded to us beyond the storage reserve) back to the
            // original client. Without this, the extra TON sits on the
            // job contract and eventually leaves as part of the payout —
            // going to the provider or back to the client via the normal
            // payout path, which means the client silently overpays gas
            // on behalf of whoever receives the budget.
            reserveToncoinsOnBalance(MIN_STORAGE, RESERVE_MODE_AT_MOST);
            createMessage({
                bounce: BounceMode.NoBounce,
                dest: msg.sender,
                value: 0,
                body: beginCell().endCell()
            }).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
        }

        TakeJob => {
            assert(in.valueCoins >= MIN_GAS_STATE_CHANGE) throw ERR_INSUFFICIENT_FUNDS;
            val (jobId, factory, client, provider, state, det) = loadMainData();
            assert(state == STATE_FUNDED) throw ERR_INVALID_STATE;
            assert(provider == null) throw ERR_ALREADY_HAS_PROVIDER;

            // BUG-2 fix: evaluator must not be able to take their own job,
            // otherwise they could accept-and-self-approve for a free payout.
            var ds = det.beginParse();
            val evaluator = ds.loadAddress();
            assert(in.senderAddress != evaluator) throw ERR_ACCESS_DENIED;

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
            assert(in.valueCoins >= MIN_GAS_STATE_CHANGE) throw ERR_INSUFFICIENT_FUNDS;
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
            assert(in.valueCoins >= MIN_GAS_STATE_CHANGE) throw ERR_INSUFFICIENT_FUNDS;
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
            assert(in.valueCoins >= MIN_GAS_JETTON_PAYOUT) throw ERR_INSUFFICIENT_FUNDS;
            val (jobId, factory, client, provider, state, detCell) = loadMainData();
            assert(state == STATE_SUBMITTED) throw ERR_INVALID_STATE;
            val (evaluator, budget, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, _, jettonWallet) = loadDetails(detCell);
            assert(in.senderAddress == evaluator) throw ERR_ACCESS_DENIED;

            val newDet = buildDetailsCell(evaluator, budget, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, msg.reason, jettonWallet);

            // Two-phase settlement: park in SETTLING_* while the jetton
            // transfer is in flight. If it bounces the state stays
            // SETTLING_* and the recipient can call RetryTransfer.
            if (msg.approved != 0) {
                saveData(jobId, factory, client, provider, STATE_SETTLING_COMPLETED, newDet);
                sendJettonPayout(jettonWallet, budget, provider!, evaluator);
            } else {
                saveData(jobId, factory, client, provider, STATE_SETTLING_DISPUTED, newDet);
                sendJettonPayout(jettonWallet, budget, client, evaluator);
            }
        }

        ClaimJob => {
            assert(in.valueCoins >= MIN_GAS_JETTON_PAYOUT) throw ERR_INSUFFICIENT_FUNDS;
            val (jobId, factory, client, provider, state, detCell) = loadMainData();
            assert(state == STATE_SUBMITTED) throw ERR_INVALID_STATE;
            assert(provider != null) throw ERR_NO_PROVIDER;
            assert(in.senderAddress == provider!) throw ERR_ACCESS_DENIED;

            val (_, budget, _, _, _, _, evalTimeout, submittedAt, _, _, jettonWallet) = loadDetails(detCell);
            val evalDeadline = submittedAt + evalTimeout;
            assert(blockchain.now() >= evalDeadline) throw ERR_EVAL_TIMEOUT_NOT_EXPIRED;

            saveData(jobId, factory, client, provider, STATE_SETTLING_COMPLETED, detCell);
            sendJettonPayout(jettonWallet, budget, provider!, provider!);
        }

        CancelJob => {
            assert(in.valueCoins >= MIN_GAS_STATE_CHANGE) throw ERR_INSUFFICIENT_FUNDS;
            val (jobId, factory, client, provider, state, detCell) = loadMainData();
            assert(in.senderAddress == client) throw ERR_ACCESS_DENIED;
            // Allow cancel in either OPEN (no jettons have been sent, no
            // provider can be affected) or FUNDED (gated by timeout).
            assert(state == STATE_OPEN || state == STATE_FUNDED) throw ERR_INVALID_STATE;

            if (state == STATE_FUNDED) {
                // FUNDED cancel refunds the jetton payout — needs the
                // higher jetton-payout gas floor.
                assert(in.valueCoins >= MIN_GAS_JETTON_PAYOUT) throw ERR_INSUFFICIENT_FUNDS;
                val (_, budget, _, _, timeout, createdAt, _, _, _, _, jettonWallet) = loadDetails(detCell);
                val deadline = createdAt + timeout;
                assert(blockchain.now() >= deadline) throw ERR_TIMEOUT_NOT_EXPIRED;

                saveData(jobId, factory, client, provider, STATE_SETTLING_CANCELLED, detCell);
                sendJettonPayout(jettonWallet, budget, client, client);
            } else {
                // OPEN cancel: no jettons have been received, nothing to
                // transfer. Just mark terminal and return storage TON.
                saveData(jobId, factory, client, provider, STATE_CANCELLED, detCell);
                createMessage({
                    bounce: BounceMode.NoBounce,
                    dest: client,
                    value: 0,
                    body: beginCell().endCell()
                }).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
            }
        }

        RetryTransfer => {
            assert(in.valueCoins >= MIN_GAS_JETTON_PAYOUT) throw ERR_INSUFFICIENT_FUNDS;
            val (jobId, factory, client, provider, state, detCell) = loadMainData();
            assert(
                state == STATE_SETTLING_COMPLETED
                || state == STATE_SETTLING_DISPUTED
                || state == STATE_SETTLING_CANCELLED
            ) throw ERR_INVALID_STATE;

            val (_, budget, _, _, _, _, _, _, _, _, jettonWallet) = loadDetails(detCell);

            // Recipient depends on which terminal branch we were headed for.
            var recipient: address = client;
            if (state == STATE_SETTLING_COMPLETED) {
                assert(provider != null) throw ERR_NO_PROVIDER;
                recipient = provider!;
            }
            assert(in.senderAddress == recipient) throw ERR_ACCESS_DENIED;

            // Re-issue the jetton transfer. Excess TON returns to caller.
            sendJettonPayout(jettonWallet, budget, recipient, in.senderAddress);
        }

        CommitSettlement => {
            assert(in.valueCoins >= MIN_GAS_STATE_CHANGE) throw ERR_INSUFFICIENT_FUNDS;
            val (jobId, factory, client, provider, state, detCell) = loadMainData();
            assert(
                state == STATE_SETTLING_COMPLETED
                || state == STATE_SETTLING_DISPUTED
                || state == STATE_SETTLING_CANCELLED
            ) throw ERR_INVALID_STATE;

            // Recipient-only: only the party that would have received the
            // jettons can assert that settlement is done. We cannot verify
            // jetton balance on a separate jetton wallet from here.
            var recipient: address = client;
            if (state == STATE_SETTLING_COMPLETED) {
                assert(provider != null) throw ERR_NO_PROVIDER;
                recipient = provider!;
            }
            assert(in.senderAddress == recipient) throw ERR_ACCESS_DENIED;

            var finalState: int = STATE_CANCELLED;
            if (state == STATE_SETTLING_COMPLETED) {
                finalState = STATE_COMPLETED;
            } else if (state == STATE_SETTLING_DISPUTED) {
                finalState = STATE_DISPUTED;
            }
            saveData(jobId, factory, client, provider, finalState, detCell);

            createMessage({
                bounce: BounceMode.NoBounce,
                dest: in.senderAddress,
                value: 0,
                body: beginCell().endCell()
            }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_IGNORE_ERRORS);
        }

        EmergencyReclaim => {
            assert(in.valueCoins >= MIN_GAS_JETTON_PAYOUT) throw ERR_INSUFFICIENT_FUNDS;
            val (jobId, factory, client, provider, state, detCell) = loadMainData();
            assert(in.senderAddress == client) throw ERR_ACCESS_DENIED;
            assert(
                state == STATE_SETTLING_COMPLETED
                || state == STATE_SETTLING_DISPUTED
                || state == STATE_SETTLING_CANCELLED
            ) throw ERR_INVALID_STATE;

            val (_, budget, _, _, _, createdAt, _, _, _, _, jettonWallet) = loadDetails(detCell);
            assert(blockchain.now() >= createdAt + TIMEOUT_BYPASS) throw ERR_BYPASS_NOT_ALLOWED;

            // Exit SETTLING permanently into DISPUTED with the jetton
            // payout directed at the client regardless of the prior branch.
            saveData(jobId, factory, client, provider, STATE_DISPUTED, detCell);
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
