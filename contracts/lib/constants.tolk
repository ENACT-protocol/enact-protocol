tolk 1.3

// Shared constants used by job.tolk, jetton_job.tolk, and — via the
// factories — by every deployed ENACT job. Single source of truth so a
// state enum rename or error-code reshuffle has one place to touch and
// both contract families stay in sync.

// -------------------- States --------------------

const STATE_OPEN: int = 0;
const STATE_FUNDED: int = 1;
const STATE_SUBMITTED: int = 2;
const STATE_COMPLETED: int = 3;
const STATE_DISPUTED: int = 4;
const STATE_CANCELLED: int = 5;
// Two-phase settlement: intermediate states between "evaluator decided"
// and "funds delivered". Entered when a terminal op fires an outbound
// payout, exited via CommitSettlement (success), RetryTransfer + Commit
// (after bounce), or EmergencyReclaim (client escape after 30 days).
const STATE_SETTLING_COMPLETED: int = 6;
const STATE_SETTLING_DISPUTED: int = 7;
const STATE_SETTLING_CANCELLED: int = 8;

// -------------------- Errors --------------------

const ERR_ACCESS_DENIED: int = 100;
const ERR_INVALID_STATE: int = 101;
const ERR_TIMEOUT_NOT_EXPIRED: int = 102;
const ERR_ALREADY_HAS_PROVIDER: int = 103;
const ERR_INSUFFICIENT_FUNDS: int = 104;
const ERR_EVAL_TIMEOUT_NOT_EXPIRED: int = 105;
const ERR_BUDGET_NOT_SET: int = 106;
const ERR_NO_PROVIDER: int = 107;
// ERR_JETTON_WALLET_NOT_SET (108) is jetton-specific; kept in jetton_job.tolk
const ERR_NOTHING_TO_RETRY: int = 109;
const ERR_SETTLEMENT_NOT_DRAINED: int = 110;
const ERR_BYPASS_NOT_ALLOWED: int = 111;

// -------------------- Gas minimums --------------------

// Every handler that sends an outbound payout checks `in.valueCoins`
// against one of these floors before touching state. This keeps a
// caller from underpaying and having the contract write terminal
// state for a payout that then fails at the action phase.
const MIN_GAS_STATE_CHANGE: int = 30000000;   // 0.03 TON
const MIN_GAS_PAYOUT: int = 100000000;        // 0.10 TON (TON payouts)
const MIN_GAS_JETTON_PAYOUT: int = 120000000; // 0.12 TON (jetton payouts: forward 0.02 + wallet gas)

// -------------------- Timeouts --------------------

// Emergency escape hatch: after this duration in SETTLING the client
// can force-close the job and receive the remaining funds, regardless
// of which SETTLING_* branch we were on. Prevents funds from being
// locked forever if the intended recipient is permanently unreachable.
const TIMEOUT_BYPASS: int = 2592000; // 30 days
