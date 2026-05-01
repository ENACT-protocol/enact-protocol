# ENACT v2-final implementation plan

Living plan for the v2-final contract + SDK release. **No v3** — every
feature here lands in v2 before mainnet. Phased so each phase ships,
gets tested on testnet, and stabilises before the next starts.

Status legend: `✓` shipped, `→` in progress, `·` queued.

## Phase 0 — already shipped on `testnet` branch

- `✓` MTONGA-step-2 tariff sync (gas budgets ÷5 across SDK/bot/MCP/Python)
- `✓` Aggressive `MIN_STORAGE` reduction (0.003 → 0.0003 TON, ~3.7× cheaper)
- `✓` Aggressive `MIN_GAS_*` floors (state change 0.005, payout 0.015,
  jetton-payout 0.025) — synced with SDK/bot/MCP via spread schema
- `✓` Library-mode factory deploy (8.1× CreateJob savings vs v1 mainnet)
- `✓` Real on-chain gas-bench scripts (`scripts/gas-bench-*.ts`)
- `✓` SubmitResult race-guard on jetton job: `assert(pendingBudget == 0)`

## Phase 1 — small architectural wins ✓ shipped (commit fc29705)

- `✓` **Hook gas param** — replaced the inline `value: 10000000` in
  `fireAfterEvaluate` with a `hookGas` field stored in v2 ref. Default
  0.01 TON via `DEFAULT_HOOK_GAS` in `lib/constants.tolk`. CreateJob
  accepts optional `hookGas` arg; 0 = use default.
  - `contracts/job.tolk` + `contracts/jetton_job.tolk` v2Cell layout
    extended with trailing `coins` field after the existing fields.
  - `loadDetails` / `buildDetailsCell` / `loadClaimFields` /
    `rebuildWithDeadline` all updated to read+preserve hookGas.
  - `wrappers/JobFactory.ts` + `wrappers/JettonJobFactory.ts` accept
    `hookGas: bigint` via `buildV2InitParams` /
    `buildJettonV2InitParams`.
  - 119 sandbox tests pass on the new bytecode.

- `✓` **SubmitResult pendingBudget guard** — `assert(pendingBudget == 0)`
  in jetton_job's SubmitResult handler. Prevents stranded jetton-delta
  when client races a SetBudget+ top-up against provider's submit.
  Forces client to either drain the pending top-up via
  TransferNotification or roll back via SetBudget before submit lands.

## Phase 2 — factory-derives-jettonWallet

The current model lets the client call `SetJettonWallet` to declare the
contract's expected jetton wallet. A malicious client can declare a
wallet of a fake jetton master, fund with the fake token, evaluator
approves, provider receives garbage. Mitigation:

- `→` Factory's `CreateJettonJob` accepts `jettonMaster: address`.
  Factory derives the child's expected `jettonWallet =
  wallet_of(jobAddr, jettonMaster)` using the standard jetton wallet
  state-init formula, then bakes that address into the child's
  initial state. Removes `SetJettonWallet` opcode entirely. UX is one
  step shorter; the spoofing path is closed.
- `contracts/jetton_job_factory*.tolk`: take `jettonMaster`, compute
  jetton-wallet address inline.
- `contracts/jetton_job.tolk`: drop `SetJettonWallet` handler.
- `wrappers/JettonJobFactory.ts` + `sdk/src/client.ts` +
  `mcp-server/src/index.ts` + `bot/src/index.ts`: createJettonJob takes
  `jettonMaster`.

## Phase 3 — external event emission

Out-message external_in events on every state transition.
Tonviewer / TonAPI / any third-party indexer subscribes without
deploying a hook contract.

- `→` Define event taxonomy: `JobCreated`, `JobFunded`, `JobTaken`,
  `JobSubmitted`, `JobApproved`, `JobRejected`, `JobCancelled`,
  `JobClaimed`, `JobQuit`, `BudgetSet`, `WindowExtended`,
  `ProviderAccepted`. Each carries `(jobId, factoryAddr, sender,
  timestamp)` plus op-specific fields.
- Tolk emit pattern via `createMessage({ dest: ext_addr_none, … }).send()`.
- Indexer: listen for these events instead of polling state.

## Phase 4 — multi-jetton SDK / MCP / bot

Contracts already support per-job jettons (the wallet is stored
per-job). Surface that in clients:

- `→` Remove all `USDT_MASTER` hardcodes from `mcp-server/src/index.ts`,
  `bot/src/index.ts`, SDK examples.
- All jetton-creating tools accept `jetton_master: string` param.
- Bot `/create_job` dialog: token picker (USDT, NOT, TON-bridged
  stables, custom).
- Indexer schema: jobs table gets `jetton_master`, `jetton_symbol`,
  `jetton_decimals`. Explorer pulls metadata from jetton master and
  shows symbol next to the budget.

## Phase 5 — multi-evaluator quorum (M-of-N)

The single-evaluator model is ENACT v1's biggest centralisation point.
Quorum closes that.

- `→` State change: `evaluator: address` → `evaluators: dict<address>`
  with `threshold: uint8`. v2 ref carries them.
- `EvaluateJob` becomes additive: each evaluator submits their
  approve/reject vote with their reason hash. Contract tracks
  `votedFor: dict<address, bool>`. When `≥ threshold` votes match
  (approve=true OR approve=false), terminal state is committed.
- Tie-breaking: if approve and reject both reach threshold (e.g. 2-of-3
  where 2 approve, 2 reject is impossible — but with 4-of-7 ties
  matter), reject wins (refund client). Closes the griefing path.
- `quorum: 1-of-1` is the current single-evaluator behavior, kept as
  default for backwards compat.
- New errors: `ERR_NOT_EVALUATOR`, `ERR_ALREADY_VOTED`.

## Phase 6 — reputation hook contract

Standalone TEP-style contract referenced via the existing v2 hook
mechanism. Optional, opt-in per job. Future TEP submission.

- `→` `contracts/extensions/reputation.tolk`: stores
  `dict<provider, { approved: int, rejected: int, totalBudget: coins }>`.
  Single opcode `OP_AFTER_EVALUATE` (already defined). Aggregates a
  rolling reputation score on every evaluation hit.
- Get-methods: `get_provider_score(addr)`, `get_top_providers(n)`,
  `get_total_jobs_seen()`.
- `scripts/deploy-reputation.ts`: standalone deploy.
- Bot/Explorer: surface reputation score next to provider addresses
  when a job's hookAddress points at the canonical reputation contract.

## Phase 7 — dynamic min-gas getter (config drift safety)

When TON does MTONGA step 3-7 we don't want to redeploy factories.

- `→` Add `get_min_gas_state_change()`, `get_min_gas_payout()`,
  `get_min_gas_jetton_payout()` getters on every Job/JettonJob (just
  return the current constants — they're already in `lib/constants.tolk`).
- SDK reads these on first contact with a factory and caches them in
  `EnactClient._minGas`. Used by every `_send` call to choose attached
  TON value. Falls back to compile-time defaults if reads fail.
- Future tariff cuts: redeploy contracts with new constants → SDK
  auto-detects via getter → no SDK upgrade required.

## Phase 8 — closing items

- `→` `reason` → `reasonHash` rename (BoC layout cosmetic — does break
  binary compat with v1 mainnet so only safe for the v2 cut). Done as
  part of the v2-final spec doc.
- `→` `get_v2_data()` split into `get_mode_deadline()`,
  `get_hook_config()`, `get_quorum()` — easier for SDK consumers.
- `→` All audit findings cleaned: emitted events, fee derivations
  documented, spec frozen.

## Done definition for v2-final

- All phases above shipped on `testnet` branch.
- Real on-chain gas-bench shows ≥ 6× reduction across every opcode vs
  v1 mainnet.
- 119 sandbox tests + 9 testnet e2e scenarios all green on the final
  factory hashes.
- Mainnet redeploy plan written; coordinates the rotation from v1
  factory to v2-final factory (proxy contract or migration window).
- Public spec doc at `enact.info/docs/v2-spec` mirrors what's on chain.
