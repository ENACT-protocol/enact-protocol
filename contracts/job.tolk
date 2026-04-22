tolk 1.3

import "@stdlib/gas-payments"
import "lib/constants.tolk"
import "lib/job_state.tolk"

// ===================== CONTRACT-LOCAL CONSTANTS =====================

// Everything in `lib/constants.tolk` is imported above. Only constants
// that differ between TON jobs and jetton jobs live here.
const MIN_STORAGE: int = 10000000;  // 0.01 TON reserve for storage fees

// ===================== STORAGE LAYOUT =====================
// Main cell layout and loadMainData / saveData live in
// `lib/job_state.tolk` — identical to jetton_job.tolk so both contracts
// stay in sync without duplication.
//
// Details cell (TON-specific — jetton variant adds jettonWallet):
//   evaluatorAddr:address, budget:coins,
//   descHash:uint256, resultHash:uint256
//   ref1 → extCell (v1 fields)
//   ref2 → v2Cell (v2 fields)
//
// extCell:
//   timeout:uint32, createdAt:uint32,
//   evalTimeout:uint32, submittedAt:uint32,
//   resultType:uint8, reason:uint256
//
// v2Cell:
//   mode:uint8,                     // MODE_FIXED or MODE_APPLICATION
//   applicationDeadline:uint32,     // absolute ts; 0 for FIXED
//   hookAddress:address             // addr_none if no hook configured

fun loadDetails(detailsCell: cell): (address, int, int, int, int, int, int, int, int, int, int, int, address?) {
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

    var v2s = v2Cell.beginParse();
    val mode = v2s.loadUint(8);
    val applicationDeadline = v2s.loadUint(32);
    val hasHook = v2s.loadBool();
    var hookAddress: address? = null;
    if (hasHook) {
        hookAddress = v2s.loadAddress();
    }

    return (evaluator, budget, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, reason, mode, applicationDeadline, hookAddress);
}

fun buildDetailsCell(evaluator: address, budget: int, descHash: int, resultHash: int,
                     timeout: int, createdAt: int, evalTimeout: int, submittedAt: int,
                     resultType: int, reason: int,
                     mode: int, applicationDeadline: int, hookAddress: address?): cell {
    val extCell = beginCell()
        .storeUint(timeout, 32)
        .storeUint(createdAt, 32)
        .storeUint(evalTimeout, 32)
        .storeUint(submittedAt, 32)
        .storeUint(resultType, 8)
        .storeUint(reason, 256)
        .endCell();

    var v2b = beginCell()
        .storeUint(mode, 8)
        .storeUint(applicationDeadline, 32);
    if (hookAddress != null) {
        v2b.storeBool(true).storeAddress(hookAddress!);
    } else {
        v2b.storeBool(false);
    }
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

// ===================== AFTER-EVALUATE HOOK =====================

// Fire-and-forget notification to an optional hook address. Scheduled
// from EvaluateJob / ClaimJob so external contracts (reputation
// registries, agent dashboards) can react to a job result without the
// job contract ever depending on the hook's code. Silent on failure —
// the hook is advisory; a broken hook must never stall settlement.
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
    // Nominal 0.01 TON attached to the hook message. If the contract's
    // balance is short the send silently no-ops (IGNORE_ERRORS) — the
    // hook is best-effort, never load-bearing on settlement.
    createMessage({
        bounce: BounceMode.NoBounce,
        dest: hookAddress!,
        value: 10000000,
        body: b.endCell(),
    }).send(SEND_MODE_IGNORE_ERRORS);
}

// ===================== MESSAGES =====================

// Opcodes are CRC-32 of the operation name for TEP-62-style
// interoperability. The comment next to each struct documents the
// source string; callers (SDKs, bots, explorers) compute the same
// hash off-chain to construct message bodies.

// 0x7a90f051 = CRC32("op::fund_job")
struct (0x7a90f051) FundJob {}

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

// 0xbb8c8df3 = CRC32("op::init_job") — v2 carries a ref with the new fields
// (mode, applicationWindow, hookAddress). See job_factory.tolk for the layout.
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

// ---------- v2 AppMode opcodes ----------
// AcceptProvider: client picks the winning off-chain bid. The provider
// signed a bid cell (jobAddr, proposedBudget, providerAddr) off-chain
// with ed25519; the contract recomputes the same cell, verifies the
// signature, and assigns the provider atomically. If proposedBudget
// differs from the current budget the contract tops up — see body.
// 0x663a16f6 = CRC32("op::accept_provider")
struct (0x663a16f6) AcceptProvider {
    providerAddress: address;
    proposedBudget: coins;
    providerPubkey: uint256;
    signatureRef: cell;      // first 512 bits = ed25519 signature
}

// ExtendWindow: client pushes the application deadline further into the
// future. No-op on FIXED mode jobs.
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

            // Parse v2 ref cell: mode(8) + applicationWindow(32) + Maybe address (hook).
            var v2s = msg.v2Ref.beginParse();
            val mode = v2s.loadUint(8);
            val applicationWindow = v2s.loadUint(32);
            val hasHook = v2s.loadBool();
            var hookAddress: address? = null;
            if (hasHook) {
                hookAddress = v2s.loadAddress();
            }
            assert(mode == MODE_FIXED || mode == MODE_APPLICATION) throw ERR_WRONG_MODE;

            // APPLICATION jobs seed the deadline at deploy time so
            // providers can start bidding before the client funds. FIXED
            // jobs carry deadline=0 — it is never read in that mode.
            var deadline: int = 0;
            if (mode == MODE_APPLICATION) {
                deadline = blockchain.now() + applicationWindow;
            }

            val det = buildDetailsCell(
                msg.evaluatorAddress, msg.budget, msg.descriptionHash,
                0, msg.timeout, 0, msg.evaluationTimeout, 0, 0, 0,
                mode, deadline, hookAddress
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

        SetBudget => {
            assert(in.valueCoins >= MIN_GAS_STATE_CHANGE) throw ERR_INSUFFICIENT_FUNDS;
            val (jobId, factory, client, provider, state, detCell) = loadMainData();
            // v2: SetBudget is valid in OPEN (no funds locked) and in
            // FUNDED for top-ups. In FUNDED the new budget must be
            // strictly greater than the current one and the client must
            // send the delta in msg.value. Decrease is rejected —
            // refunding jettons/TON from a live FUNDED escrow re-introduces
            // the BUG-1 class of payout failures we killed in Phase 1.
            assert(state == STATE_OPEN || state == STATE_FUNDED) throw ERR_INVALID_STATE;
            assert(in.senderAddress == client) throw ERR_ACCESS_DENIED;

            val (evaluator, curBudget, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, reason, mode, appDeadline, hookAddr) = loadDetails(detCell);

            if (state == STATE_FUNDED) {
                assert(msg.budget > curBudget) throw ERR_BUDGET_DECREASE;
                val delta = msg.budget - curBudget;
                // delta for the escrow + MIN_GAS_STATE_CHANGE for the handler.
                assert(in.valueCoins >= delta + MIN_GAS_STATE_CHANGE) throw ERR_INSUFFICIENT_FUNDS;
            }

            val newDet = buildDetailsCell(evaluator, msg.budget, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, reason, mode, appDeadline, hookAddr);
            saveData(jobId, factory, client, provider, state, newDet);

            // FUNDED: keep newBudget + MIN_STORAGE on the contract, return
            // any excess to the client. OPEN: no funds held, just bounce
            // the remaining message value back.
            if (state == STATE_FUNDED) {
                reserveToncoinsOnBalance(msg.budget + MIN_STORAGE, RESERVE_MODE_AT_MOST);
                createMessage({
                    bounce: BounceMode.NoBounce,
                    dest: in.senderAddress,
                    value: 0,
                    body: beginCell().endCell()
                }).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
            } else {
                createMessage({
                    bounce: BounceMode.NoBounce,
                    dest: in.senderAddress,
                    value: 0,
                    body: beginCell().endCell()
                }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_IGNORE_ERRORS);
            }
        }

        ExtendWindow => {
            assert(in.valueCoins >= MIN_GAS_STATE_CHANGE) throw ERR_INSUFFICIENT_FUNDS;
            val (jobId, factory, client, provider, state, detCell) = loadMainData();
            assert(state == STATE_OPEN || state == STATE_FUNDED) throw ERR_INVALID_STATE;
            assert(in.senderAddress == client) throw ERR_ACCESS_DENIED;

            val (evaluator, budget, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, reason, mode, curDeadline, hookAddr) = loadDetails(detCell);
            assert(mode == MODE_APPLICATION) throw ERR_WRONG_MODE;
            // Monotonic push — no snap-backs. Clients who mistyped a far
            // deadline must cancel and recreate.
            assert(msg.newDeadline > curDeadline) throw ERR_APP_WINDOW_EXPIRED;

            val newDet = buildDetailsCell(evaluator, budget, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, reason, mode, msg.newDeadline, hookAddr);
            saveData(jobId, factory, client, provider, state, newDet);

            createMessage({
                bounce: BounceMode.NoBounce,
                dest: in.senderAddress,
                value: 0,
                body: beginCell().endCell()
            }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_IGNORE_ERRORS);
        }

        FundJob => {
            assert(in.valueCoins >= MIN_GAS_STATE_CHANGE) throw ERR_INSUFFICIENT_FUNDS;
            val (jobId, factory, client, provider, state, detCell) = loadMainData();
            assert(in.senderAddress == client) throw ERR_ACCESS_DENIED;
            assert(state == STATE_OPEN) throw ERR_INVALID_STATE;

            val (evaluator, budget, descHash, resultHash, timeout, _, evalTimeout, submittedAt, resultType, reason, mode, appDeadline, hookAddr) = loadDetails(detCell);
            assert(budget > 0) throw ERR_BUDGET_NOT_SET;
            assert(in.valueCoins >= budget) throw ERR_INSUFFICIENT_FUNDS;

            val newDet = buildDetailsCell(evaluator, budget, descHash, resultHash, timeout, blockchain.now(), evalTimeout, submittedAt, resultType, reason, mode, appDeadline, hookAddr);
            saveData(jobId, factory, client, provider, STATE_FUNDED, newDet);

            // Keep budget + storage on contract, return excess to client
            reserveToncoinsOnBalance(budget + MIN_STORAGE, RESERVE_MODE_AT_MOST);
            createMessage({
                bounce: BounceMode.NoBounce,
                dest: in.senderAddress,
                value: 0,
                body: beginCell().endCell()
            }).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
        }

        TakeJob => {
            assert(in.valueCoins >= MIN_GAS_STATE_CHANGE) throw ERR_INSUFFICIENT_FUNDS;
            val (jobId, factory, client, provider, state, det) = loadMainData();
            assert(state == STATE_FUNDED) throw ERR_INVALID_STATE;
            assert(provider == null) throw ERR_ALREADY_HAS_PROVIDER;

            // BUG-2 fix: evaluator must not be able to take their own job.
            var ds = det.beginParse();
            val evaluator = ds.loadAddress();
            assert(in.senderAddress != evaluator) throw ERR_ACCESS_DENIED;

            // v2: TakeJob is the FIXED-mode entry point. APPLICATION jobs
            // assign the provider via AcceptProvider only — allowing
            // TakeJob here would let a racer front-run the client's chosen
            // bid winner.
            val (_, _, _, _, _, _, _, _, _, _, mode, _, _) = loadDetails(det);
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

            val (evaluator, curBudget, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, reason, mode, appDeadline, hookAddr) = loadDetails(detCell);
            assert(mode == MODE_APPLICATION) throw ERR_WRONG_MODE;
            // Evaluator is declared up-front; a bid from the evaluator
            // would be a self-approval vector the same as BUG-2.
            assert(msg.providerAddress != evaluator) throw ERR_ACCESS_DENIED;
            assert(blockchain.now() <= appDeadline) throw ERR_APP_WINDOW_EXPIRED;

            // Budget must match or exceed current (monotonic top-up on
            // acceptance). Decrease is rejected for the same reason as
            // SetBudget in FUNDED — no live-escrow refunds.
            assert(msg.proposedBudget >= curBudget) throw ERR_BUDGET_DECREASE;
            if (msg.proposedBudget > curBudget) {
                val delta = msg.proposedBudget - curBudget;
                assert(in.valueCoins >= delta + MIN_GAS_STATE_CHANGE) throw ERR_INSUFFICIENT_FUNDS;
            }

            // Reconstruct the cell the provider signed. Any mismatch in
            // jobAddr/budget/providerAddr invalidates the signature.
            val signedCell = beginCell()
                .storeAddress(contract.getAddress())
                .storeCoins(msg.proposedBudget)
                .storeAddress(msg.providerAddress)
                .endCell();
            val signedHash = signedCell.hash();
            var sigSlice = msg.signatureRef.beginParse();
            val signature = sigSlice.loadBits(512);
            assert(isSignatureValid(signedHash, signature, msg.providerPubkey)) throw ERR_BAD_SIGNATURE;

            val newDet = buildDetailsCell(evaluator, msg.proposedBudget, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, reason, mode, appDeadline, hookAddr);
            saveData(jobId, factory, client, msg.providerAddress, STATE_FUNDED, newDet);

            // Keep newBudget + MIN_STORAGE on contract, return excess.
            reserveToncoinsOnBalance(msg.proposedBudget + MIN_STORAGE, RESERVE_MODE_AT_MOST);
            createMessage({
                bounce: BounceMode.NoBounce,
                dest: in.senderAddress,
                value: 0,
                body: beginCell().endCell()
            }).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
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

            val (evaluator, budget, descHash, _, timeout, createdAt, evalTimeout, _, _, reason, mode, appDeadline, hookAddr) = loadDetails(detCell);
            val newDet = buildDetailsCell(evaluator, budget, descHash, msg.resultHash, timeout, createdAt, evalTimeout, blockchain.now(), msg.resultType, reason, mode, appDeadline, hookAddr);
            saveData(jobId, factory, client, provider, STATE_SUBMITTED, newDet);

            createMessage({
                bounce: BounceMode.NoBounce,
                dest: in.senderAddress,
                value: 0,
                body: beginCell().endCell()
            }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_IGNORE_ERRORS);
        }

        EvaluateJob => {
            assert(in.valueCoins >= MIN_GAS_PAYOUT) throw ERR_INSUFFICIENT_FUNDS;
            val (jobId, factory, client, provider, state, detCell) = loadMainData();
            assert(state == STATE_SUBMITTED) throw ERR_INVALID_STATE;
            val (evaluator, budget, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, _, mode, appDeadline, hookAddr) = loadDetails(detCell);
            assert(in.senderAddress == evaluator) throw ERR_ACCESS_DENIED;

            val newDet = buildDetailsCell(evaluator, budget, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, msg.reason, mode, appDeadline, hookAddr);

            // afterEvaluate hook fires before the payout branch so the
            // hook message is scheduled from contract balance, not from
            // the CARRY_ALL_BALANCE payout. Hook is nominal-value
            // (0.01 TON), non-bouncing, IGNORE_ERRORS — settlement must
            // not depend on hook success.
            fireAfterEvaluate(hookAddr, jobId, msg.approved, provider);

            // Two-phase settlement: enter SETTLING_* parking orbit. The
            // outbound payout is bounceable; if it succeeds the contract
            // balance drops to MIN_STORAGE and CommitSettlement finalizes
            // the state.
            if (msg.approved != 0) {
                saveData(jobId, factory, client, provider, STATE_SETTLING_COMPLETED, newDet);
                reserveToncoinsOnBalance(MIN_STORAGE, RESERVE_MODE_AT_MOST);
                createMessage({
                    bounce: BounceMode.Only256BitsOfBody,
                    dest: provider!,
                    value: 0,
                    body: beginCell().endCell()
                }).send(SEND_MODE_CARRY_ALL_BALANCE);
            } else {
                saveData(jobId, factory, client, provider, STATE_SETTLING_DISPUTED, newDet);
                reserveToncoinsOnBalance(MIN_STORAGE, RESERVE_MODE_AT_MOST);
                createMessage({
                    bounce: BounceMode.Only256BitsOfBody,
                    dest: client,
                    value: 0,
                    body: beginCell().endCell()
                }).send(SEND_MODE_CARRY_ALL_BALANCE);
            }
        }

        ClaimJob => {
            assert(in.valueCoins >= MIN_GAS_PAYOUT) throw ERR_INSUFFICIENT_FUNDS;
            val (jobId, factory, client, provider, state, detCell) = loadMainData();
            assert(state == STATE_SUBMITTED) throw ERR_INVALID_STATE;
            assert(provider != null) throw ERR_NO_PROVIDER;
            assert(in.senderAddress == provider!) throw ERR_ACCESS_DENIED;

            val (_, _, _, _, _, _, evalTimeout, submittedAt, _, _, _, _, hookAddr) = loadDetails(detCell);
            val evalDeadline = submittedAt + evalTimeout;
            assert(blockchain.now() >= evalDeadline) throw ERR_EVAL_TIMEOUT_NOT_EXPIRED;

            // Claim counts as an implicit approval — fire the hook with
            // approved=1 so reputation trackers see the provider got paid.
            fireAfterEvaluate(hookAddr, jobId, 1, provider);

            saveData(jobId, factory, client, provider, STATE_SETTLING_COMPLETED, detCell);
            reserveToncoinsOnBalance(MIN_STORAGE, RESERVE_MODE_AT_MOST);
            createMessage({
                bounce: BounceMode.Only256BitsOfBody,
                dest: provider!,
                value: 0,
                body: beginCell().endCell()
            }).send(SEND_MODE_CARRY_ALL_BALANCE);
        }

        CancelJob => {
            assert(in.valueCoins >= MIN_GAS_STATE_CHANGE) throw ERR_INSUFFICIENT_FUNDS;
            val (jobId, factory, client, provider, state, detCell) = loadMainData();
            assert(in.senderAddress == client) throw ERR_ACCESS_DENIED;
            assert(state == STATE_OPEN || state == STATE_FUNDED) throw ERR_INVALID_STATE;

            if (state == STATE_FUNDED) {
                assert(in.valueCoins >= MIN_GAS_PAYOUT) throw ERR_INSUFFICIENT_FUNDS;
                val (_, _, _, _, timeout, createdAt, _, _, _, _, _, _, _) = loadDetails(detCell);
                val deadline = createdAt + timeout;
                assert(blockchain.now() >= deadline) throw ERR_TIMEOUT_NOT_EXPIRED;

                saveData(jobId, factory, client, provider, STATE_SETTLING_CANCELLED, detCell);
                reserveToncoinsOnBalance(MIN_STORAGE, RESERVE_MODE_AT_MOST);
                createMessage({
                    bounce: BounceMode.Only256BitsOfBody,
                    dest: client,
                    value: 0,
                    body: beginCell().endCell()
                }).send(SEND_MODE_CARRY_ALL_BALANCE);
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
            assert(in.valueCoins >= MIN_GAS_PAYOUT) throw ERR_INSUFFICIENT_FUNDS;
            val (jobId, factory, client, provider, state, detCell) = loadMainData();
            assert(
                state == STATE_SETTLING_COMPLETED
                || state == STATE_SETTLING_DISPUTED
                || state == STATE_SETTLING_CANCELLED
            ) throw ERR_INVALID_STATE;

            val (_, budget, _, _, _, _, _, _, _, _, _, _, _) = loadDetails(detCell);

            var recipient: address = client;
            if (state == STATE_SETTLING_COMPLETED) {
                assert(provider != null) throw ERR_NO_PROVIDER;
                recipient = provider!;
            }
            assert(in.senderAddress == recipient) throw ERR_ACCESS_DENIED;

            assert(contract.getOriginalBalance() >= budget) throw ERR_NOTHING_TO_RETRY;

            reserveToncoinsOnBalance(MIN_STORAGE, RESERVE_MODE_AT_MOST);
            createMessage({
                bounce: BounceMode.Only256BitsOfBody,
                dest: recipient,
                value: 0,
                body: beginCell().endCell()
            }).send(SEND_MODE_CARRY_ALL_BALANCE);
        }

        CommitSettlement => {
            assert(in.valueCoins >= MIN_GAS_STATE_CHANGE) throw ERR_INSUFFICIENT_FUNDS;
            val (jobId, factory, client, provider, state, detCell) = loadMainData();
            assert(
                state == STATE_SETTLING_COMPLETED
                || state == STATE_SETTLING_DISPUTED
                || state == STATE_SETTLING_CANCELLED
            ) throw ERR_INVALID_STATE;

            val (_, budget, _, _, _, _, _, _, _, _, _, _, _) = loadDetails(detCell);

            assert(contract.getOriginalBalance() < budget) throw ERR_SETTLEMENT_NOT_DRAINED;

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
            assert(in.valueCoins >= MIN_GAS_PAYOUT) throw ERR_INSUFFICIENT_FUNDS;
            val (jobId, factory, client, provider, state, detCell) = loadMainData();
            assert(in.senderAddress == client) throw ERR_ACCESS_DENIED;
            assert(
                state == STATE_SETTLING_COMPLETED
                || state == STATE_SETTLING_DISPUTED
                || state == STATE_SETTLING_CANCELLED
            ) throw ERR_INVALID_STATE;

            val (_, _, _, _, _, createdAt, _, _, _, _, _, _, _) = loadDetails(detCell);
            assert(blockchain.now() >= createdAt + TIMEOUT_BYPASS) throw ERR_BYPASS_NOT_ALLOWED;

            saveData(jobId, factory, client, provider, STATE_DISPUTED, detCell);
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
    val (evaluator, budget, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, reason, _, _, _) = loadDetails(detCell);
    return (jobId, client, provider, evaluator, budget, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, reason, state);
}

get fun get_state(): int {
    val (_, _, _, _, state, _) = loadMainData();
    return state;
}

// v2: surface the mode / AppMode window / hook so SDKs can render
// application-tab UIs without needing a second contract variant.
get fun get_v2_data(): (int, int, address?) {
    val (_, _, _, _, _, detCell) = loadMainData();
    val (_, _, _, _, _, _, _, _, _, _, mode, applicationDeadline, hookAddress) = loadDetails(detCell);
    return (mode, applicationDeadline, hookAddress);
}
