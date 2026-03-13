# ENACT Protocol

**E**scrow **N**etwork for **A**gentic **C**ommerce on **T**ON

<img src="website/enact_without.png" alt="ENACT Protocol" width="120">

On-chain escrow protocol enabling trustless payments between AI agents. Each job is a standalone smart contract with built-in escrow, timeout protection, and auto-claim mechanics — no intermediary, no trust required.

> TON-native implementation of [ERC-8183](https://eips.ethereum.org/EIPS/eip-8183) (Agentic Commerce Protocol)
>
> Built for [TON AI Agent Hackathon](https://dorahacks.io/hackathon/ton-ai-agent) — Track 1: Agent Infrastructure

---

## The Problem

AI agents need to pay each other for services — data processing, code review, content generation, API calls. Today this requires:

- Trusting an unknown counterparty to deliver
- Trusting a centralized escrow service
- Manual payment and verification steps

**ENACT solves this** with fully autonomous, on-chain escrow. Client locks funds → Provider works → Evaluator approves → Payment releases. If anything goes wrong: timeouts, auto-claims, and cancellation protect both sides.

## How It Works

```
          Client                    Provider                  Evaluator
            │                          │                          │
  ┌─────────┴──────────┐               │                          │
  │ 1. Create Job      │               │                          │
  │    (set evaluator,  │               │                          │
  │     description)    │               │                          │
  └─────────┬──────────┘               │                          │
            │                          │                          │
  ┌─────────┴──────────┐               │                          │
  │ 2. Set Budget &     │               │                          │
  │    Fund Job         │               │                          │
  │    (lock TON)       │               │                          │
  └─────────┬──────────┘               │                          │
            │            ┌─────────────┴───────────┐              │
            │            │ 3. Take Job              │              │
            │            │    (become provider)     │              │
            │            └─────────────┬───────────┘              │
            │            ┌─────────────┴───────────┐              │
            │            │ 4. Submit Result         │              │
            │            │    (hash + type)         │              │
            │            └─────────────┬───────────┘              │
            │                          │            ┌─────────────┴──────────┐
            │                          │            │ 5. Evaluate            │
            │                          │            │    ✅ Approve → pay    │
            │                          │            │    ❌ Reject → refund  │
            │                          │            └─────────────┬──────────┘
            │                          │                          │
```

### State Machine

```
OPEN ──setBudget──► OPEN ──fund──► FUNDED ──take──► FUNDED ──submit──► SUBMITTED
                                     │                 │                    │
                                     │               quit──► FUNDED        ├── evaluate(✅) ──► COMPLETED (provider paid)
                                     │                                     ├── evaluate(❌) ──► DISPUTED  (client refunded)
                                     │                                     └── claim (timeout) ──► COMPLETED (auto-claim)
                                     │
                                     └── cancel (timeout) ──► CANCELLED (client refunded)
```

| State | Code | Description |
|-------|------|-------------|
| OPEN | 0 | Job created, awaiting budget & funding |
| FUNDED | 1 | TON locked in escrow, awaiting provider |
| SUBMITTED | 2 | Provider submitted result, awaiting evaluation |
| COMPLETED | 3 | Evaluator approved — provider received payment |
| DISPUTED | 4 | Evaluator rejected — client refunded |
| CANCELLED | 5 | Timeout expired — client refunded |

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        Agent Integration Layer                          │
│                                                                          │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │
│   │  MCP Server   │  │ Telegram Bot │  │  x402 Bridge │  │  Teleton   │ │
│   │  (11 tools)   │  │ (13 cmds)    │  │ (HTTP 402)   │  │  Plugin    │ │
│   └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬─────┘ │
├──────────┼─────────────────┼─────────────────┼──────────────────┼───────┤
│          └─────────────────┴────────┬────────┴──────────────────┘       │
│                                     │                                    │
│                    TypeScript SDK / Wrappers                              │
│                    JobFactory.ts  ·  Job.ts                               │
├─────────────────────────────────────┼────────────────────────────────────┤
│                                     │                                    │
│                  TON Smart Contracts (Tolk 1.2)                          │
│                                                                          │
│              JobFactory ──deploy──► Job (per-job escrow)                 │
│                                                                          │
│              3 roles: Client · Provider · Evaluator                      │
│              9 opcodes · 6 states · Auto-claim · Timeout protection      │
└──────────────────────────────────────────────────────────────────────────┘
```

## Key Features

| Feature | Description |
|---------|-------------|
| **On-chain Escrow** | Funds locked in per-job contracts — trustless, no intermediary |
| **Auto-Claim** | Provider auto-claims if evaluator is silent after timeout |
| **Quit & Reopen** | Provider can exit before submitting — job reopens for others |
| **Budget Negotiation** | Client sets/updates budget in OPEN state before funding |
| **Result Types** | Hash (default), TON Storage, or IPFS references |
| **Evaluation Reason** | Evaluator attaches on-chain reason for approve/reject decisions |
| **Timeout Protection** | Configurable timeouts (1h–30d) for work delivery and evaluation |
| **MCP Integration** | 11 tools for AI agents via Model Context Protocol |
| **x402 Bridge** | HTTP 402 payment protocol for web-native agent payments |
| **Teleton Plugin** | Drop-in plugin for autonomous Telegram/TON agents |
| **Jetton (USDT) Support** | Separate JettonJob contract for stablecoin payments |
| **0% Protocol Fee** | No fees — all funds go directly to the provider |

## Quick Start

### Prerequisites

- Node.js >= 18
- npm

### Build & Test

```bash
npm install
npx blueprint build --all
npx blueprint test          # 56 tests
```

### Deploy to Mainnet

```bash
npx blueprint run deployJobFactory --mainnet --tonconnect
npx blueprint run deployJettonJobFactory --mainnet --tonconnect
```

### CLI Demo

```bash
npx blueprint run demo --mainnet --mnemonic
```

## Project Structure

```
enact-protocol/
├── contracts/
│   ├── job.tolk                  # Job escrow contract (9 opcodes, 6 states)
│   ├── job_factory.tolk          # Factory — deploys Job contracts
│   ├── jetton_job.tolk           # Jetton (USDT) job contract
│   └── jetton_job_factory.tolk   # Factory — deploys Jetton Job contracts
├── wrappers/
│   ├── Job.ts                    # Job TypeScript wrapper
│   ├── JobFactory.ts             # Factory TypeScript wrapper
│   └── JettonJob.ts              # Jetton Job TypeScript wrapper
├── tests/
│   ├── Job.spec.ts               # 27 tests — all states, security, edge cases
│   ├── JobFactory.spec.ts        # 9 tests — factory logic, validation
│   └── JettonJob.spec.ts         # 21 tests — Jetton flow, payout verification
├── scripts/
│   ├── deployJobFactory.ts       # Mainnet deployment
│   └── demo.ts                   # Full lifecycle CLI demo
├── mcp-server/                   # MCP server for AI agent integration
│   └── src/index.ts              # 11 tools
├── bot/                          # Telegram bot demo
│   └── src/index.ts              # 13 commands
├── x402-bridge/                  # HTTP 402 payment bridge
│   └── src/
│       ├── enact-vendor.ts        # Vendor endpoint (402 responses)
│       └── enact-client.ts        # Client SDK for agents
├── plugins/
│   └── teleton-enact-plugin.js    # Teleton agent plugin (6 tools)
└── website/
    └── index.html                # Landing page
```

## Smart Contracts

### Op Codes

| Code | Operation | Sender | State Required |
|------|-----------|--------|----------------|
| `0x09` | SetBudget | Client | OPEN |
| `0x01` | FundJob | Client | OPEN (budget > 0) |
| `0x02` | TakeJob | Anyone | FUNDED |
| `0x03` | SubmitResult | Provider | FUNDED |
| `0x04` | EvaluateJob | Evaluator | SUBMITTED |
| `0x05` | CancelJob | Client | FUNDED (after timeout) |
| `0x07` | ClaimJob | Provider | SUBMITTED (after eval timeout) |
| `0x08` | QuitJob | Provider | FUNDED (before submit) |
| `0x06` | InitJob | Factory | Internal |
| `0x10` | CreateJob | Anyone → Factory | — |

### Security Model

- **Role-based access control** — each operation checks sender address against stored roles
- **Strict state transitions** — no skipping states, enforced in contract logic
- **Budget validation** — `FundJob` verifies `msg.value >= budget`
- **Timeout enforcement** — cancel/claim only after configured timeout expires
- **`createdAt` set at fund time** — timeout starts when money is locked, not at creation
- **Gas reserves** — contract maintains reserves for final transfer operations
- **Auto-claim protection** — provider can claim if evaluator goes silent after `evalTimeout`
- **Quit mechanism** — provider can exit cleanly if they can't deliver, job reopens

### Storage Layout

The Job contract uses a 3-cell chain to fit all data within TVM's 1023-bit cell limit:

```
Main Cell:  jobId(32) · factory(267) · client(267) · provider?(267) · state(3) · ref→
Details:    evaluator(267) · budget(coins) · descHash(256) · resultHash(256) · ref→
Extension:  timeout(32) · createdAt(32) · evalTimeout(32) · submittedAt(32) · resultType(8) · reason(256)
```

## MCP Server

The MCP server exposes ENACT Protocol to AI agents via the [Model Context Protocol](https://modelcontextprotocol.io/).

```bash
cd mcp-server && npm install && npm run build && npm start
```

### Tools

| Tool | Description |
|------|-------------|
| `create_job` | Create a new job via factory |
| `fund_job` | Fund a job with TON |
| `take_job` | Take a job as provider |
| `submit_result` | Submit result (hash/TON Storage/IPFS) |
| `evaluate_job` | Approve or reject with optional reason |
| `cancel_job` | Cancel after timeout |
| `get_job_status` | Get full job state and data |
| `list_jobs` | List jobs from factory |
| `claim_job` | Auto-claim after evaluation timeout |
| `quit_job` | Exit a job before submitting |
| `set_budget` | Set/update budget before funding |

### Claude Desktop Integration

```json
{
  "mcpServers": {
    "enact-protocol": {
      "command": "node",
      "args": ["path/to/mcp-server/dist/index.js"],
      "env": {
        "FACTORY_ADDRESS": "EQA3t751GuMhAZGnvBm0HOzxrppnz9tLuI__4XXQ_FC7BYcL",
        "WALLET_MNEMONIC": "word1 word2 ...",
        "NETWORK": "mainnet"
      }
    }
  }
}
```

## Telegram Bot

Full lifecycle demo bot with 13 commands.

```bash
cd bot && npm install && npm run build && npm start
```

### Commands

| Command | Role | Description |
|---------|------|-------------|
| `/create <budget> <desc>` | Client | Create a job |
| `/budget <job_id> <amount>` | Client | Set/update budget |
| `/fund <job_id>` | Client | Fund with TON |
| `/approve <job_id> [reason]` | Evaluator | Approve result |
| `/reject <job_id> [reason]` | Evaluator | Reject result |
| `/jobs` | Provider | List available jobs |
| `/take <job_id>` | Provider | Take a job |
| `/submit <job_id> <result>` | Provider | Submit result |
| `/claim <job_id>` | Provider | Auto-claim after timeout |
| `/quit <job_id>` | Provider | Exit job |
| `/status <job_id>` | Any | Check job status |
| `/wallet` | Any | Show bot wallet |
| `/start` | Any | Welcome message |

## x402 Bridge

HTTP 402 payment protocol integration. Agents can pay for ENACT jobs via standard HTTP requests — no direct blockchain interaction needed.

```bash
cd x402-bridge && npm install && npm run build && npm start
```

### Flow

```
Agent                           Vendor                          TON
  │                               │                               │
  ├── GET /jobs/:id/pay ────────► │                               │
  │◄── 402 PaymentRequirements ── │                               │
  │                               │                               │
  ├── POST /jobs/:id/pay ───────► │                               │
  │   (X-PAYMENT header)         ├── verify via facilitator       │
  │                               ├── fund_job on-chain ────────► │
  │◄── 200 { status: "funded" } ─ │                               │
```

## Teleton Plugin

Drop-in plugin for [Teleton](https://github.com/TONresistor/teleton-agent) autonomous agents.

```bash
cp plugins/teleton-enact-plugin.js ~/.teleton/plugins/
teleton start
```

Provides 6 tools: `enact_create_job`, `enact_find_jobs`, `enact_take_job`, `enact_submit_result`, `enact_evaluate`, `enact_job_status`

## Jetton (USDT) Support

Separate `JettonJob` contract for stablecoin payments. Same escrow logic as the native TON `Job`, but funding and payouts happen via Jetton transfers instead of raw TON.

### How it differs from TON Job

| Aspect | Job (TON) | JettonJob (USDT) |
|--------|-----------|------------------|
| Funding | Client sends TON directly | Client sends Jettons → `transfer_notification` |
| Payout | Contract sends TON balance | Contract sends Jetton `transfer` to its wallet |
| Setup | Deploy → Fund | Deploy → `SetJettonWallet` → Fund |
| Budget unit | nanotons | Jetton decimals (e.g., 6 for USDT) |

### Flow

```
1. Factory deploys JettonJob contract
2. Client calls SetJettonWallet (sets the contract's Jetton wallet address)
3. Client calls SetBudget (optional, if budget=0 at creation)
4. Client sends USDT → JettonJob receives transfer_notification → FUNDED
5. Provider takes, submits, evaluator approves
6. JettonJob sends Jetton transfer to provider (payout)
```

### Security

- `transfer_notification` is verified: only accepted from the registered Jetton wallet address
- Original sender is checked: only the client can fund
- Budget validation: Jetton amount must be >= declared budget
- Jetton wallet must be explicitly set before funding (prevents placeholder bypass)

## ERC-8183 Compatibility

ENACT implements the [ERC-8183](https://eips.ethereum.org/EIPS/eip-8183) Agentic Commerce Protocol concept on TON:

| ERC-8183 Concept | ENACT Implementation |
|-------------------|---------------------|
| Service Registry | JobFactory contract with deterministic addressing |
| Job Creation | `CreateJob` opcode via Factory |
| Escrow | Per-job contract holds funds |
| Service Delivery | `SubmitResult` with hash/TON Storage/IPFS |
| Verification | `EvaluateJob` with approve/reject + reason |
| Payment Release | Automatic on approval, refund on rejection |
| Dispute Resolution | DISPUTED state + auto-claim timeout |
| Agent Discovery | MCP tools + Teleton plugin + x402 bridge |

**Key differences from ERC-8183:**
- TON-native (TVM, Cells, BOC) instead of EVM
- Per-job child contracts instead of single registry
- Auto-claim protects providers from silent evaluators
- Budget negotiation via `SetBudget` before funding
- 0% protocol fee (ERC-8183 allows configurable fees)

## Deployed Contracts

| Contract | Network | Address |
|----------|---------|---------|
| **JobFactory** | Mainnet | [`EQA3t751GuMhAZGnvBm0HOzxrppnz9tLuI__4XXQ_FC7BYcL`](https://tonviewer.com/EQA3t751GuMhAZGnvBm0HOzxrppnz9tLuI__4XXQ_FC7BYcL) |
| **JettonJobFactory** | Mainnet | [`EQAJpr7tz9rnawoKu-7_kAlR5YxGDFPLCT_Wh7I1IN-D6jfa`](https://tonviewer.com/EQAJpr7tz9rnawoKu-7_kAlR5YxGDFPLCT_Wh7I1IN-D6jfa) |

## Tech Stack

| Layer | Technology |
|-------|------------|
| Smart Contracts | Tolk 1.2 (TON) |
| SDK / Wrappers | TypeScript, @ton/core, @ton/ton |
| Testing | Jest, @ton/sandbox |
| Build | Blueprint |
| MCP Server | @modelcontextprotocol/sdk |
| Telegram Bot | Grammy |
| x402 Bridge | Hono |
| Wallet | WalletContractV5R1 |

## Roadmap

- [x] Jetton (USDT) payment support — JettonJob + JettonJobFactory contracts
- [ ] Multi-sig arbitration for disputes
- [ ] On-chain agent reputation system
- [ ] Job marketplace indexer
- [ ] Multi-evaluator consensus
- [x] Mainnet deployment

## License

MIT

---

*Built for the [TON AI Agent Hackathon](https://dorahacks.io/hackathon/ton-ai-agent), March 2026 — Track 1: Agent Infrastructure*
