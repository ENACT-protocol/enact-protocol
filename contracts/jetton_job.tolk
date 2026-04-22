tolk 1.3

import "@stdlib/gas-payments"
import "lib/constants.tolk"
import "lib/job_state.tolk"

// ===================== CONTRACT-LOCAL CONSTANTS =====================

// Shared constants come from `lib/constants.tolk`. Only the
// jetton-specific pieces live here:

// 108 is reserved for jetton-only errors; kept as a local constant
// because the TON contract never raises it.
const ERR_JETTON_WALLET_NOT_SET: int = 108;

// Jetton job storage is slightly more compact than TON job storage,
// hence the tighter MIN_STORAGE.
const MIN_STORAGE: int = 5000000;   // 0.005 TON reserve for storage fees

const OP_JETTON_TRANSFER: int = 0x0f8a7ea5;

// ===================== STORAGE LAYOUT =====================
// Main cell layout and loadMainData / saveData live in
// `lib/job_state.tolk` and are shared with job.tolk.
//
// Details cell (jetton variant — extra jettonWallet in ext, v2 adds jettonMaster):
//   evaluatorAddr:address, budget:coins,
//   descHash:uint256, resultHash:uint256
//   ref1 → extCell (v1 fields + jettonWallet)
//   ref2 → v2Cell (v2 fields + jettonMaster + pendingBudget)
//
// extCell:
//   timeout:uint32, createdAt:uint32,
//   evalTimeout:uint32, submittedAt:uint32,
//   resultType:uint8, reason:uint256,
//   jettonWallet:address
//
// v2Cell:
//   mode:uint8,
//   applicationDeadline:uint32,
//   hookAddress:address?,
//   jettonMaster:address?,        // trusted metadata, not verified on-chain
//   pendingBudget:coins            // top-up target set by SetBudget in FUNDED;
//                                  // 0 when no top-up is pending

fun loadDetails(detailsCell: cell): (address, int, int, int, int, int, int, int, int, int, address, int, int, address?, address?, int) {
    var ds = detailsCell.beginParse();
    val evaluator = ds.loadAddress();
    val budget = ds.loadCoins();
    val descHash = ds.loadUint(256);
    val resultHash = ds.loadUint(256);
    val extCell = ds.loadRef();
    val v2Cell = ds.loadRef();

    var es = extCell.beginParse();
    val timeout = es.loadUint(32);
    val createdAt = es.loadUint(32);
    val evalTimeout = es.loadUint(32);
    val submittedAt = es.loadUint(32);
    val resultType = es.loadUint(8);
    val reason = es.loadUint(256);
    val jettonWallet = es.loadAddress();

    var v2s = v2Cell.beginParse();
    val mode = v2s.loadUint(8);
    val applicationDeadline = v2s.loadUint(32);
    val hasHook = v2s.loadBool();
    var hookAddress: address? = null;
    if (hasHook) {
        hookAddress = v2s.loadAddress();
    }
    val hasMaster = v2s.loadBool();
    var jettonMaster: address? = null;
    if (hasMaster) {
        jettonMaster = v2s.loadAddress();
    }
    val pendingBudget = v2s.loadCoins();

    return (evaluator, budget, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, reason, jettonWallet, mode, applicationDeadline, hookAddress, jettonMaster, pendingBudget);
}

fun buildDetailsCell(evaluator: address, budget: int, descHash: int, resultHash: int,
                     timeout: int, createdAt: int, evalTimeout: int, submittedAt: int,
                     resultType: int, reason: int, jettonWallet: address,
                     mode: int, applicationDeadline: int, hookAddress: address?,
                     jettonMaster: address?, pendingBudget: int): cell {
    val extCell = beginCell()
        .storeUint(timeout, 32)
        .storeUint(createdAt, 32)
        .storeUint(evalTimeout, 32)
        .storeUint(submittedAt, 32)
        .storeUint(resultType, 8)
        .storeUint(reason, 256)
        .storeAddress(jettonWallet)
        .endCell();

    var v2b = beginCell()
        .storeUint(mode, 8)
        .storeUint(applicationDeadline, 32);
    if (hookAddress != null) {
        v2b.storeBool(true).storeAddress(hookAddress!);
    } else {
        v2b.storeBool(false);
    }
    if (jettonMaster != null) {
        v2b.storeBool(true).storeAddress(jettonMaster!);
    } else {
        v2b.storeBool(false);
    }
    v2b.storeCoins(pendingBudget);
    val v2Cell = v2b.endCell();

    return beginCell()
        .storeAddress(evaluator)
        .storeCoins(budget)
        .storeUint(descHash, 256)
        .storeUint(resultHash, 256)
        .storeRef(extCell)
        .storeRef(v2Cell)
        .endCell();
}

// ===================== JETTON TRANSFER HELPER =====================

fun sendJettonPayout(jw: address, jettonAmount: int, recipient: address, returnExcessTo: address) {
    val body = beginCell()
        .storeUint(OP_JETTON_TRANSFER, 32)
        .storeUint(0, 64)             // query_id
        .storeCoins(jettonAmount)     // Jetton amount
        .storeAddress(recipient)      // destination
        .storeAddress(returnExcessTo) // response_destination
        .storeBool(false)             // no custom_payload
        .storeCoins(20000000)         // forward_ton_amount 0.02 TON
        .storeBool(false)             // no forward_payload
        .endCell();

    reserveToncoinsOnBalance(MIN_STORAGE, RESERVE_MODE_AT_MOST);
    createMessage({
        bounce: BounceMode.Only256BitsOfBody,
        dest: jw,
        value: 0,
        body: body,
    }).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
}

// ===================== AFTER-EVALUATE HOOK =====================

// Kept in sync with job.tolk. See that file for rationale.
// 0x6f0e4a7c = CRC32("notify::after_evaluate")
const OP_AFTER_EVALUATE: int = 0x6f0e4a7c;

fun fireAfterEvaluate(hookAddress: address?, jobId: int, approved: int, providerAddr: address?) {
    if (hookAddress == null) {
        return;
    }
    var b = beginCell()
        .storeUint(OP_AFTER_EVALUATE, 32)
        .storeUint(jobId, 32)
        .storeUint(approved, 8);
    if (providerAddr != null) {
        b.storeBool(true).storeAddress(providerAddr!);
    } else {
        b.storeBool(false);
    }
    createMessage({
        bounce: BounceMode.NoBounce,
        dest: hookAddress!,
        value: 10000000,
        body: b.endCell(),
    }).send(SEND_MODE_IGNORE_ERRORS);
}

// ===================== MESSAGES =====================

// CRC-32 opcodes: same scheme as job.tolk.

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

// V2 params ride in a plain ref. Jetton ref layout (wider than TON):
//   mode:uint8, applicationWindow:uint32,
//   hookAddress:(Maybe address), jettonMaster:(Maybe address).

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
    v2Ref: cell;
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

// ---------- v2 AppMode opcodes ----------
// 0x663a16f6 = CRC32("op::accept_provider")
struct (0x663a16f6) AcceptProvider {
    providerAddress: address;
    proposedBudget: coins;
    providerPubkey: uint256;
    signatureRef: cell;
}

// 0x16b321c2 = CRC32("op::extend_window")
struct (0x16b321c2) ExtendWindow {
    newDeadline: uint32;
}

// ---------- Two-phase settlement opcodes ----------
// 0xa7665d4e = CRC32("op::retry_transfer")
struct (0xa7665d4e) RetryTransfer {}

// 0xe1f3102b = CRC32("op::commit_settlement")
struct (0xe1f3102b) CommitSettlement {}

// 0x2c31d1c3 = CRC32("op::emergency_reclaim")
struct (0x2c31d1c3) EmergencyReclaim {}

// TEP-74 standard transfer_notification opcode.
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
    | AcceptProvider
    | ExtendWindow
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

            var v2s = msg.v2Ref.beginParse();
            val mode = v2s.loadUint(8);
            val applicationWindow = v2s.loadUint(32);
            val hasHook = v2s.loadBool();
            var hookAddress: address? = null;
            if (hasHook) {
                hookAddress = v2s.loadAddress();
            }
            val hasMaster = v2s.loadBool();
            var jettonMaster: address? = null;
            if (hasMaster) {
                jettonMaster = v2s.loadAddress();
            }
            assert(mode == MODE_FIXED || mode == MODE_APPLICATION) throw ERR_WRONG_MODE;

            var deadline: int = 0;
            if (mode == MODE_APPLICATION) {
                deadline = blockchain.now() + applicationWindow;
            }

            val det = buildDetailsCell(
                msg.evaluatorAddress, msg.budget, msg.descriptionHash,
                0, msg.timeout, 0, msg.evaluationTimeout, 0, 0, 0, factory,
                mode, deadline, hookAddress, jettonMaster, 0
            );
            saveData(msg.jobId, factory, msg.clientAddress, null, STATE_OPEN, det);

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

            val (evaluator, budget, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, reason, currentWallet, mode, appDeadline, hookAddr, jettonMaster, pendingBudget) = loadDetails(detCell);
            assert(currentWallet == factory) throw ERR_INVALID_STATE;

            val newDet = buildDetailsCell(evaluator, budget, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, reason, msg.jettonWallet, mode, appDeadline, hookAddr, jettonMaster, pendingBudget);
            saveData(jobId, factory, client, provider, STATE_OPEN, newDet);

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
            // v2: SetBudget valid in OPEN (just bump the number) or in
            // FUNDED (set `pendingBudget` so a follow-up TransferNotification
            // carrying the delta flips `budget` to the new value). Unlike
            // the TON contract we cannot atomically top up here — jettons
            // must arrive via a separate transfer from the client's jetton
            // wallet.
            assert(state == STATE_OPEN || state == STATE_FUNDED) throw ERR_INVALID_STATE;
            assert(in.senderAddress == client) throw ERR_ACCESS_DENIED;

            val (evaluator, curBudget, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, reason, jettonWallet, mode, appDeadline, hookAddr, jettonMaster, _) = loadDetails(detCell);

            if (state == STATE_FUNDED) {
                assert(msg.budget > curBudget) throw ERR_BUDGET_DECREASE;
                val newDet = buildDetailsCell(evaluator, curBudget, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, reason, jettonWallet, mode, appDeadline, hookAddr, jettonMaster, msg.budget);
                saveData(jobId, factory, client, provider, state, newDet);
            } else {
                // OPEN: no jettons have arrived; just update target budget.
                // pendingBudget stays 0 — it is only meaningful in FUNDED.
                val newDet = buildDetailsCell(evaluator, msg.budget, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, reason, jettonWallet, mode, appDeadline, hookAddr, jettonMaster, 0);
                saveData(jobId, factory, client, provider, state, newDet);
            }

            createMessage({
                bounce: BounceMode.NoBounce,
                dest: in.senderAddress,
                value: 0,
                body: beginCell().endCell()
            }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_IGNORE_ERRORS);
        }

        ExtendWindow => {
            assert(in.valueCoins >= MIN_GAS_STATE_CHANGE) throw ERR_INSUFFICIENT_FUNDS;
            val (jobId, factory, client, provider, state, detCell) = loadMainData();
            assert(state == STATE_OPEN || state == STATE_FUNDED) throw ERR_INVALID_STATE;
            assert(in.senderAddress == client) throw ERR_ACCESS_DENIED;

            val (evaluator, budget, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, reason, jettonWallet, mode, curDeadline, hookAddr, jettonMaster, pendingBudget) = loadDetails(detCell);
            assert(mode == MODE_APPLICATION) throw ERR_WRONG_MODE;
            assert(msg.newDeadline > curDeadline) throw ERR_APP_WINDOW_EXPIRED;

            val newDet = buildDetailsCell(evaluator, budget, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, reason, jettonWallet, mode, msg.newDeadline, hookAddr, jettonMaster, pendingBudget);
            saveData(jobId, factory, client, provider, state, newDet);

            createMessage({
                bounce: BounceMode.NoBounce,
                dest: in.senderAddress,
                value: 0,
                body: beginCell().endCell()
            }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_IGNORE_ERRORS);
        }

        TransferNotification => {
            val (jobId, factory, client, provider, state, detCell) = loadMainData();
            // v2: TransferNotification is accepted in both OPEN (initial
            // funding) and FUNDED (top-up for an earlier SetBudget). Any
            // other state has no pending transfer to settle — reject.
            // CAVEAT: the SDK/bot must coordinate top-up ordering. If a
            // client stages SetBudget in FUNDED and the provider calls
            // SubmitResult (SUBMITTED) before the jetton delta lands, the
            // incoming TransferNotification reverts but the jettons
            // themselves already sit on the job's jetton wallet and
            // sendJettonPayout only pulls `budget` — the delta is
            // stranded. UIs must pre-check state before forwarding the
            // jetton transfer; this is documented here rather than fixed
            // on-chain because the fix (pulling pendingBudget + budget
            // on payout) breaks the FUNDED-only invariant `budget ==
            // jettons_actually_escrowed` that the rest of the contract
            // relies on.
            assert(state == STATE_OPEN || state == STATE_FUNDED) throw ERR_INVALID_STATE;

            val (evaluator, budget, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, reason, jettonWallet, mode, appDeadline, hookAddr, jettonMaster, pendingBudget) = loadDetails(detCell);
            assert(in.senderAddress == jettonWallet) throw ERR_ACCESS_DENIED;
            assert(jettonWallet != factory) throw ERR_JETTON_WALLET_NOT_SET;
            assert(msg.sender == client) throw ERR_ACCESS_DENIED;

            if (state == STATE_OPEN) {
                assert(budget > 0) throw ERR_BUDGET_NOT_SET;
                assert(msg.amount == budget) throw ERR_INSUFFICIENT_FUNDS;

                val newDet = buildDetailsCell(evaluator, budget, descHash, resultHash, timeout, blockchain.now(), evalTimeout, submittedAt, resultType, reason, jettonWallet, mode, appDeadline, hookAddr, jettonMaster, pendingBudget);
                saveData(jobId, factory, client, provider, STATE_FUNDED, newDet);
            } else {
                // FUNDED top-up: must match the pending delta exactly.
                // If no top-up was requested (pendingBudget == 0) we
                // reject — the client sent a stray jetton transfer.
                assert(pendingBudget > 0) throw ERR_INVALID_STATE;
                val delta = pendingBudget - budget;
                assert(msg.amount == delta) throw ERR_INSUFFICIENT_FUNDS;

                // Promote: budget = pendingBudget, clear pending.
                val newDet = buildDetailsCell(evaluator, pendingBudget, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, reason, jettonWallet, mode, appDeadline, hookAddr, jettonMaster, 0);
                saveData(jobId, factory, client, provider, STATE_FUNDED, newDet);
            }

            // Return the forward-TON excess back to the client.
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

            var ds = det.beginParse();
            val evaluator = ds.loadAddress();
            assert(in.senderAddress != evaluator) throw ERR_ACCESS_DENIED;

            val (_, _, _, _, _, _, _, _, _, _, _, mode, _, _, _, _) = loadDetails(det);
            assert(mode == MODE_FIXED) throw ERR_WRONG_MODE;

            saveData(jobId, factory, client, in.senderAddress, STATE_FUNDED, det);

            createMessage({
                bounce: BounceMode.NoBounce,
                dest: in.senderAddress,
                value: 0,
                body: beginCell().endCell()
            }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_IGNORE_ERRORS);
        }

        AcceptProvider => {
            assert(in.valueCoins >= MIN_GAS_STATE_CHANGE) throw ERR_INSUFFICIENT_FUNDS;
            val (jobId, factory, client, provider, state, detCell) = loadMainData();
            assert(state == STATE_FUNDED) throw ERR_INVALID_STATE;
            assert(provider == null) throw ERR_ALREADY_HAS_PROVIDER;
            assert(in.senderAddress == client) throw ERR_ACCESS_DENIED;

            val (evaluator, curBudget, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, reason, jettonWallet, mode, appDeadline, hookAddr, jettonMaster, pendingBudget) = loadDetails(detCell);
            assert(mode == MODE_APPLICATION) throw ERR_WRONG_MODE;
            assert(msg.providerAddress != evaluator) throw ERR_ACCESS_DENIED;
            assert(blockchain.now() <= appDeadline) throw ERR_APP_WINDOW_EXPIRED;

            // Jetton AcceptProvider cannot top up the budget atomically
            // (jettons live on a separate wallet). Any budget change must
            // go through SetBudget + TransferNotification first. Here we
            // only accept bids at exactly the currently-funded budget.
            assert(msg.proposedBudget == curBudget) throw ERR_BUDGET_DECREASE;

            val signedCell = beginCell()
                .storeAddress(contract.getAddress())
                .storeCoins(msg.proposedBudget)
                .storeAddress(msg.providerAddress)
                .endCell();
            val signedHash = signedCell.hash();
            var sigSlice = msg.signatureRef.beginParse();
            val signature = sigSlice.loadBits(512);
            assert(isSignatureValid(signedHash, signature, msg.providerPubkey)) throw ERR_BAD_SIGNATURE;

            val newDet = buildDetailsCell(evaluator, curBudget, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, reason, jettonWallet, mode, appDeadline, hookAddr, jettonMaster, pendingBudget);
            saveData(jobId, factory, client, msg.providerAddress, STATE_FUNDED, newDet);

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

            val (evaluator, budget, descHash, _, timeout, createdAt, evalTimeout, _, _, reason, jettonWallet, mode, appDeadline, hookAddr, jettonMaster, pendingBudget) = loadDetails(detCell);
            val newDet = buildDetailsCell(evaluator, budget, descHash, msg.resultHash, timeout, createdAt, evalTimeout, blockchain.now(), msg.resultType, reason, jettonWallet, mode, appDeadline, hookAddr, jettonMaster, pendingBudget);
            saveData(jobId, factory, client, provider, STATE_SUBMITTED, newDet);

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
            val (evaluator, budget, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, _, jettonWallet, mode, appDeadline, hookAddr, jettonMaster, pendingBudget) = loadDetails(detCell);
            assert(in.senderAddress == evaluator) throw ERR_ACCESS_DENIED;

            val newDet = buildDetailsCell(evaluator, budget, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, msg.reason, jettonWallet, mode, appDeadline, hookAddr, jettonMaster, pendingBudget);

            fireAfterEvaluate(hookAddr, jobId, msg.approved, provider);

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

            val (_, budget, _, _, _, _, evalTimeout, submittedAt, _, _, jettonWallet, _, _, hookAddr, _, _) = loadDetails(detCell);
            val evalDeadline = submittedAt + evalTimeout;
            assert(blockchain.now() >= evalDeadline) throw ERR_EVAL_TIMEOUT_NOT_EXPIRED;

            fireAfterEvaluate(hookAddr, jobId, 1, provider);

            saveData(jobId, factory, client, provider, STATE_SETTLING_COMPLETED, detCell);
            sendJettonPayout(jettonWallet, budget, provider!, provider!);
        }

        CancelJob => {
            assert(in.valueCoins >= MIN_GAS_STATE_CHANGE) throw ERR_INSUFFICIENT_FUNDS;
            val (jobId, factory, client, provider, state, detCell) = loadMainData();
            assert(in.senderAddress == client) throw ERR_ACCESS_DENIED;
            assert(state == STATE_OPEN || state == STATE_FUNDED) throw ERR_INVALID_STATE;

            if (state == STATE_FUNDED) {
                assert(in.valueCoins >= MIN_GAS_JETTON_PAYOUT) throw ERR_INSUFFICIENT_FUNDS;
                val (_, budget, _, _, timeout, createdAt, _, _, _, _, jettonWallet, _, _, _, _, _) = loadDetails(detCell);
                val deadline = createdAt + timeout;
                assert(blockchain.now() >= deadline) throw ERR_TIMEOUT_NOT_EXPIRED;

                saveData(jobId, factory, client, provider, STATE_SETTLING_CANCELLED, detCell);
                sendJettonPayout(jettonWallet, budget, client, client);
            } else {
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

            val (_, budget, _, _, _, _, _, _, _, _, jettonWallet, _, _, _, _, _) = loadDetails(detCell);

            var recipient: address = client;
            if (state == STATE_SETTLING_COMPLETED) {
                assert(provider != null) throw ERR_NO_PROVIDER;
                recipient = provider!;
            }
            assert(in.senderAddress == recipient) throw ERR_ACCESS_DENIED;

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

            val (_, budget, _, _, _, createdAt, _, _, _, _, jettonWallet, _, _, _, _, _) = loadDetails(detCell);
            assert(blockchain.now() >= createdAt + TIMEOUT_BYPASS) throw ERR_BYPASS_NOT_ALLOWED;

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
    val (evaluator, budget, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, reason, jettonWallet, _, _, _, _, _) = loadDetails(detCell);
    return (jobId, client, provider, evaluator, budget, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, reason, state, jettonWallet);
}

get fun get_state(): int {
    val (_, _, _, _, state, _) = loadMainData();
    return state;
}

// v2: mode + AppMode window + hook + jettonMaster + pendingBudget.
get fun get_v2_data(): (int, int, address?, address?, int) {
    val (_, _, _, _, _, detCell) = loadMainData();
    val (_, _, _, _, _, _, _, _, _, _, _, mode, applicationDeadline, hookAddress, jettonMaster, pendingBudget) = loadDetails(detCell);
    return (mode, applicationDeadline, hookAddress, jettonMaster, pendingBudget);
}
