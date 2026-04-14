# ENACT Troubleshooting

Common errors grouped by root cause.

## "429 Too Many Requests"
TonCenter throttling. Without an API key you're capped at ~1 RPS and a single `fundJob` costs 3 RPCs.
- **Fix:** set `TONCENTER_API_KEY` (free: https://t.me/tonapibot).
- The SDK retries 3× with 2s backoff; if you still see it, reduce concurrency.

## "Job creation not confirmed on-chain"
The factory's `get_next_job_id` didn't advance within the SDK's poll window.
- **Cause:** wallet has zero TON, or the mnemonic belongs to a non-deployed v5 wallet.
- **Fix:** fund the wallet with ≥ 0.1 TON. Top up at https://ton.org/buy. Deploy happens on the first outgoing tx automatically.

## "Wallet not initialized. Pass mnemonic to constructor."
You tried to call a write method on a read-only client.
- **Fix:** construct a second client with `mnemonic`, or merge them.

## `take_job` / `submit_result` / `evaluate_job` reverts with exit code 101 (ERR_INVALID_STATE)
The job is not in the state the op requires. Op → required state:
- `fund` / `set_budget` / `set_jetton_wallet` / `cancel` → OPEN
- `take` / `quit` / `submit` (or `cancel` after timeout) → FUNDED
- `evaluate` / `claim` → SUBMITTED

Check with `getJobStatus(addr).stateName` before calling.

## `submit_result` reverts silently (bounced tx)
Your wallet didn't `take_job` first, or a different wallet took it. The contract uses `assert(senderAddress == provider)` which bounces rather than throwing a specific code.
- **Fix:** use the same mnemonic for both `takeJob` and `submitResult`.

## `evaluate_job` reverts silently (bounced tx)
Only the evaluator set at creation can evaluate — same bounce pattern.
- **Fix:** check `getJobStatus(addr).evaluator` matches your wallet.

## Jetton job: `fundJettonJob` reverts immediately
The jetton wallet address on the job contract doesn't match the USDT master's derivation.
- **Cause:** `setJettonWallet` was skipped, or it was called with the wrong master.
- **Fix:** call `setJettonWallet(addr)` after `createJettonJob`. Local MCP does this automatically; remote MCP does not.

## Encrypted result decrypts to garbage
The envelope was encrypted for a different recipient.
- **Cause:** public key of the client or evaluator changed (wallet was redeployed with a different keypair).
- **Fix:** decrypt using the original wallet's mnemonic. If lost, the result is unrecoverable — this is the whole point of E2E.

## IPFS upload hangs or 401s
Pinata JWT missing or expired.
- **Fix:** regenerate at https://app.pinata.cloud/developers/api-keys.
- **Warning:** the SDK without `pinataJwt` does NOT throw — it computes the sha256 hash, stores it on-chain, but skips the upload. The description is effectively lost because no one can fetch it from IPFS. Always pass `pinataJwt` for production.
- The MCP server throws explicitly on missing `PINATA_JWT` — safer default.

## "Pending" forever in the explorer
TonCenter returned success but the tx never reached `finalized`.
- **Cause:** insufficient gas, or network reorg.
- **Diagnose:** look up the tx at https://tonviewer.com/ — exit code tells the contract-level reason.

## `claim_job` or `cancel_job` reverts with exit code 102 (ERR_TIMEOUT_NOT_EXPIRED)
The relevant deadline hasn't elapsed yet.
- For `claim_job`: wait until `submittedAt + evalTimeout`.
- For `cancel_job` (after funding): wait until `createdAt + timeout`.
Both values are on the job state from `getJobStatus`.

## Remote MCP returns "wallet not provisioned"
First-time callers on `mcp.enact.info` are given a fresh wallet, but it's unfunded.
- **Fix:** the tool response includes a deposit address — send TON there, then retry.

## Local MCP crashes on startup: "Cannot find module '@ton/ton'"
Dependencies not installed. From the repo:
```bash
cd mcp-server && npm install && npm run build
node dist/index.js
```

## State machine confusion
Quick mental model: **OPEN → FUNDED → SUBMITTED → (COMPLETED or DISPUTED)**.
- `cancel_job` moves **OPEN → CANCELLED** at any time, or **FUNDED → CANCELLED** only after the creation timeout. A SUBMITTED job cannot be cancelled — use `evaluate_job` (reject) or `claim_job` (timeout) to resolve it.
- `claim_job` moves **SUBMITTED → COMPLETED** (provider wins unresponsive evaluator).
- `quit_job` stays in **FUNDED** (provider cleared, state unchanged).

If your code branches on reverse transitions, it's wrong — the chain will never emit them.
