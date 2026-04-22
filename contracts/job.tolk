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
//   ref → ext cell
//
// Ext cell:
//   timeout:uint32, createdAt:uint32,
//   evalTimeout:uint32, submittedAt:uint32,
//   resultType:uint8, reason:uint256

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

// Opcodes are CRC-32 of the operation name for TEP-62-style
// interoperability. The comment next to each struct documents the
// source string; callers (SDKs, bots, explorers) compute the same
// hash off-chain to construct message bodies. The previous sequential
// integer scheme (0x01..0x10) is deliberately abandoned in v2 — it
// worked but collided with any other protocol that also used small
// integers, and a TEP proposal expects named CRC-32 tags.

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

// ---------- Two-phase settlement opcodes ----------
// RetryTransfer: rightful recipient re-sends the payout while the contract
// is still in a SETTLING_* state (previous payout bounced / never landed).
// 0xa7665d4e = CRC32("op::retry_transfer")
struct (0xa7665d4e) RetryTransfer {}

// CommitSettlement: anyone can promote SETTLING_X → X once the payout has
// drained from the contract.
// 0xe1f3102b = CRC32("op::commit_settlement")
struct (0xe1f3102b) CommitSettlement {}

// EmergencyReclaim: client can pull remaining funds after TIMEOUT_BYPASS.
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
                0, msg.timeout, 0, msg.evaluationTimeout, 0, 0, 0
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
            assert(state == STATE_OPEN) throw ERR_INVALID_STATE;
            assert(in.senderAddress == client) throw ERR_ACCESS_DENIED;

            val (evaluator, _, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, reason) = loadDetails(detCell);
            val newDet = buildDetailsCell(evaluator, msg.budget, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, reason);
            saveData(jobId, factory, client, provider, STATE_OPEN, newDet);

            // Return excess
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

            val (evaluator, budget, descHash, resultHash, timeout, _, evalTimeout, submittedAt, resultType, reason) = loadDetails(detCell);
            assert(budget > 0) throw ERR_BUDGET_NOT_SET;
            assert(in.valueCoins >= budget) throw ERR_INSUFFICIENT_FUNDS;

            val newDet = buildDetailsCell(evaluator, budget, descHash, resultHash, timeout, blockchain.now(), evalTimeout, submittedAt, resultType, reason);
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

            val (evaluator, budget, descHash, _, timeout, createdAt, evalTimeout, _, _, reason) = loadDetails(detCell);
            val newDet = buildDetailsCell(evaluator, budget, descHash, msg.resultHash, timeout, createdAt, evalTimeout, blockchain.now(), msg.resultType, reason);
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
            assert(in.valueCoins >= MIN_GAS_PAYOUT) throw ERR_INSUFFICIENT_FUNDS;
            val (jobId, factory, client, provider, state, detCell) = loadMainData();
            assert(state == STATE_SUBMITTED) throw ERR_INVALID_STATE;
            val (evaluator, budget, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, _) = loadDetails(detCell);
            assert(in.senderAddress == evaluator) throw ERR_ACCESS_DENIED;

            val newDet = buildDetailsCell(evaluator, budget, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, msg.reason);

            // Two-phase settlement: enter SETTLING_* parking orbit. The
            // outbound payout is bounceable; if it succeeds the contract
            // balance drops to MIN_STORAGE and CommitSettlement finalizes
            // the state. If it bounces funds land back here and the
            // recipient can call RetryTransfer.
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

            val (_, _, _, _, _, _, evalTimeout, submittedAt, _, _) = loadDetails(detCell);
            val evalDeadline = submittedAt + evalTimeout;
            assert(blockchain.now() >= evalDeadline) throw ERR_EVAL_TIMEOUT_NOT_EXPIRED;

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
            // Allow cancel in either OPEN (no funds locked, no provider
            // can be affected) or FUNDED (gated by timeout). Without OPEN
            // cancel a client who configured the wrong evaluator or
            // changed their mind before funding cannot clean up; the job
            // would occupy storage forever.
            assert(state == STATE_OPEN || state == STATE_FUNDED) throw ERR_INVALID_STATE;

            if (state == STATE_FUNDED) {
                // FUNDED cancel sends the budgeted payout back to the
                // client; require the higher payout gas floor.
                assert(in.valueCoins >= MIN_GAS_PAYOUT) throw ERR_INSUFFICIENT_FUNDS;
                val (_, _, _, _, timeout, createdAt, _, _, _, _) = loadDetails(detCell);
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
                // OPEN cancel: no budget has been locked, no provider is
                // assigned. Mark terminal and return the storage balance
                // straight to the client — no SETTLING detour needed.
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

            val (_, budget, _, _, _, _, _, _, _, _) = loadDetails(detCell);

            // Recipient depends on which terminal branch we were headed for.
            var recipient: address = client;
            if (state == STATE_SETTLING_COMPLETED) {
                assert(provider != null) throw ERR_NO_PROVIDER;
                recipient = provider!;
            }
            assert(in.senderAddress == recipient) throw ERR_ACCESS_DENIED;

            // If the prior payout already drained the balance there is
            // nothing left to retry — caller should call CommitSettlement.
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

            val (_, budget, _, _, _, _, _, _, _, _) = loadDetails(detCell);

            // Only allow finalization once the payout has actually drained.
            // Balance at the start of this message must be below the budget,
            // proving the funds left the contract (or never were there).
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

            val (_, _, _, _, _, createdAt, _, _, _, _) = loadDetails(detCell);
            assert(blockchain.now() >= createdAt + TIMEOUT_BYPASS) throw ERR_BYPASS_NOT_ALLOWED;

            // Exit SETTLING permanently into DISPUTED with funds to client.
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
    val (evaluator, budget, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, reason) = loadDetails(detCell);
    return (jobId, client, provider, evaluator, budget, descHash, resultHash, timeout, createdAt, evalTimeout, submittedAt, resultType, reason, state);
}

get fun get_state(): int {
    val (_, _, _, _, state, _) = loadMainData();
    return state;
}
