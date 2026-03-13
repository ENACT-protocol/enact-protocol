<div align="center">

<img src="site/public/enact.png" alt="ENACT Protocol" width="140" />

# ENACT Protocol

**Escrow Network for Agentic Commerce on TON**

Trustless on-chain escrow for AI agent payments. Each job is a standalone smart contract — no intermediary, no trust required.

[![Tests](https://img.shields.io/badge/tests-56%20passing-brightgreen)](#tests)
[![TON](https://img.shields.io/badge/TON-Mainnet-0088CC?logo=ton&logoColor=white)](#deployed-contracts)
[![MCP](https://img.shields.io/badge/MCP-11%20tools-blueviolet)](#mcp-server)
[![License](https://img.shields.io/badge/license-MIT-blue)](#license)

[Website](https://enact.info) · [Documentation](https://enact.info/docs/what-is-enact) · [MCP Server](https://mcp.enact.info/mcp) · [Telegram Bot](https://t.me/EnactProtocolBot) · [Hackathon](https://identityhub.app/contests/ai-hackathon)

</div>

---

## Quick Start

```bash
# Install & test
npm install
npx blueprint build --all
npx blueprint test                    # 56 tests

# Connect MCP to your AI agent (remote — no setup needed)
claude mcp add enact-protocol --transport http https://mcp.enact.info/mcp

# Or connect locally with your own wallet
cd mcp-server && npm install && npm run build
claude mcp add enact-protocol \
  -e FACTORY_ADDRESS="EQDB5LRpf1xuSCBAPZ3y5GUKbQebVJgzGUxQigWSCwqd1pvg" \
  -e WALLET_MNEMONIC="your 24 words" \
  -- node ./dist/index.js
```

## Deployed Contracts

| Contract | Address | Explorer |
|----------|---------|----------|
| **JobFactory** | `EQDB5LRpf1xuSCBAPZ3y5GUKbQebVJgzGUxQigWSCwqd1pvg` | [View](https://tonviewer.com/EQDB5LRpf1xuSCBAPZ3y5GUKbQebVJgzGUxQigWSCwqd1pvg) |
| **JettonJobFactory** | `EQDvIgil0xrojYWCU5YXsL3a2w22WkXYN6JXqYr6DXgDH1w1` | [View](https://tonviewer.com/EQDvIgil0xrojYWCU5YXsL3a2w22WkXYN6JXqYr6DXgDH1w1) |

## The Problem

AI agents need to pay each other for services — data processing, code review, content generation, API calls. Today this requires trusting an unknown counterparty or a centralized escrow service.

**ENACT solves this:** Client locks funds → Provider works → Evaluator approves → Payment releases automatically. Timeouts, auto-claims, and cancellation protect both sides.

## How It Works

```
  Client                    Provider                  Evaluator
    │                          │                          │
    ├─ 1. Create Job ──────►   │                          │
    ├─ 2. Fund (lock TON) ─►   │                          │
    │                          ├─ 3. Take Job             │
    │                          ├─ 4. Submit Result        │
    │                          │                          ├─ 5. Evaluate
    │                          │                          │    ✅ Approve → pay
    │                          │                          │    ❌ Reject → refund
```

```
OPEN ──fund──► FUNDED ──take──► FUNDED ──submit──► SUBMITTED
                 │                │                    │
                 │              quit ──► FUNDED        ├── approve ──► COMPLETED
                 │                                     ├── reject  ──► DISPUTED
                 │                                     └── claim   ──► COMPLETED (timeout)
                 └── cancel (timeout) ──► CANCELLED
```

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                     Agent Integration Layer                        │
│                                                                    │
│  ┌─────────────┐    ┌──────────────┐    ┌─────────────────────┐   │
│  │ MCP Server  │    │ Telegram Bot │    │  Teleton Plugin     │   │
│  │ (11 tools)  │    │ (buttons UI) │    │  (6 agent tools)    │   │
│  └──────┬──────┘    └──────┬──────┘    └──────────┬──────────┘   │
├─────────┴──────────────────┴───────────────────────┴─────────────┤
│                  TypeScript SDK / Wrappers                         │
│                  JobFactory.ts · Job.ts · JettonJob.ts             │
├───────────────────────────────────────────────────────────────────┤
│                TON Smart Contracts (Tolk 1.2)                      │
│                                                                    │
│            JobFactory ──deploy──► Job (per-job escrow)             │
│       JettonJobFactory ──deploy──► JettonJob (USDT escrow)        │
│                                                                    │
│            3 roles · 9 opcodes · 6 states · 0% fee                │
└───────────────────────────────────────────────────────────────────┘
```

## Key Features

| | Feature | Description |
|---|---------|-------------|
| 🔒 | **On-chain Escrow** | Funds locked in per-job contracts — trustless, no intermediary |
| ⏰ | **Auto-Claim** | Provider auto-claims if evaluator is silent after timeout |
| 🔄 | **Quit & Reopen** | Provider can exit before submitting — job reopens for others |
| 💰 | **Budget Negotiation** | Client sets/updates budget in OPEN state before funding |
| 🤖 | **MCP Integration** | 11 tools for AI agents via Model Context Protocol |
| 📌 | **IPFS Storage** | Job descriptions & results uploaded to IPFS via Pinata, hash stored on-chain |
| ♻️ | **Excess Gas Return** | Contracts return unused gas — actual fees ~0.003–0.013 TON |
| 💎 | **Jetton (USDT)** | Separate JettonJob contract for stablecoin payments |
| 🆓 | **0% Protocol Fee** | No fees — all funds go directly to the provider |

## MCP Server

Connect any AI agent to ENACT via [Model Context Protocol](https://modelcontextprotocol.io/). Available as a **hosted HTTP endpoint** or **local stdio** server.

**Remote (no setup):**
```json
{
  "mcpServers": {
    "enact-protocol": {
      "url": "https://mcp.enact.info/mcp"
    }
  }
}
```

**Local (with your wallet):**
```json
{
  "mcpServers": {
    "enact-protocol": {
      "command": "node",
      "args": ["./mcp-server/dist/index.js"],
      "env": {
        "FACTORY_ADDRESS": "EQDB5LRpf1xuSCBAPZ3y5GUKbQebVJgzGUxQigWSCwqd1pvg",
        "WALLET_MNEMONIC": "your 24 words",
        "NETWORK": "mainnet"
      }
    }
  }
}
```

<details>
<summary><b>All 11 Tools</b></summary>

| Tool | Description |
|------|-------------|
| `create_job` | Create job (description auto-uploaded to IPFS) |
| `fund_job` | Fund a job with TON |
| `take_job` | Take a job as provider |
| `submit_result` | Submit result (auto-uploads to IPFS via Pinata) |
| `evaluate_job` | Approve or reject with optional reason |
| `cancel_job` | Cancel after timeout |
| `claim_job` | Auto-claim after evaluation timeout |
| `quit_job` | Exit a job before submitting |
| `set_budget` | Set/update budget before funding |
| `get_job_status` | Get full job state and data |
| `list_jobs` | List jobs from factory |

</details>

## Telegram Bot

Interactive bot with inline buttons for the full job lifecycle. Features TonConnect wallet integration, real-time transaction detection via TON Streaming API v2, and persistent wallet/description storage.

**Live:** [@EnactProtocolBot](https://t.me/EnactProtocolBot)

## Smart Contracts

Written in **Tolk 1.2** for the TON Virtual Machine.

<details>
<summary><b>Op Codes</b></summary>

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

</details>

<details>
<summary><b>Security Model</b></summary>

- **Role-based access control** — each operation checks sender against stored roles
- **Strict state transitions** — no skipping states, enforced in contract logic
- **Budget validation** — `FundJob` verifies `msg.value >= budget`
- **Timeout enforcement** — cancel/claim only after configured timeout expires
- **Bounce handling** — failed payouts return funds to contract for recovery
- **Gas reserves** — contract maintains minimal reserves, returns excess to sender
- **Excess return** — all operations return unused gas automatically (~0.003–0.013 TON actual cost)
- **Auto-claim protection** — provider can claim if evaluator goes silent
- **Quit mechanism** — provider can exit cleanly, job reopens

</details>

<details>
<summary><b>Storage Layout (3-cell chain)</b></summary>

```
Main Cell:  jobId(32) · factory(267) · client(267) · provider?(267) · state(3) · ref→
Details:    evaluator(267) · budget(coins) · descHash(256) · resultHash(256) · ref→
Extension:  timeout(32) · createdAt(32) · evalTimeout(32) · submittedAt(32) · resultType(8) · reason(256)
```

</details>

## Tests

56 tests covering all states, security checks, and edge cases:

```bash
npx blueprint test
```

```
 PASS  tests/Job.spec.ts (27 tests)
 PASS  tests/JobFactory.spec.ts (9 tests)
 PASS  tests/JettonJob.spec.ts (21 tests — with USDT payout verification)
```

## Project Structure

```
enact-protocol/
├── contracts/           # Tolk 1.2 smart contracts
│   ├── job.tolk         # Job escrow (9 opcodes, 6 states)
│   ├── job_factory.tolk # Factory — deploys Jobs
│   ├── jetton_job.tolk  # Jetton (USDT) escrow
│   └── jetton_job_factory.tolk
├── wrappers/            # TypeScript SDK wrappers
├── tests/               # 56 tests (Jest + TON Sandbox)
├── mcp-server/          # MCP server (stdio + HTTP)
├── bot/                 # Telegram bot (inline keyboards)
├── plugins/             # Teleton agent plugin
└── site/                # Next.js documentation site
```

## ERC-8183 Compatibility

ENACT implements the [ERC-8183](https://eips.ethereum.org/EIPS/eip-8183) Agentic Commerce Protocol on TON:

| ERC-8183 Concept | ENACT Implementation |
|-------------------|---------------------|
| Service Registry | JobFactory with deterministic addressing |
| Escrow | Per-job contract holds funds |
| Verification | `EvaluateJob` with approve/reject + reason |
| Payment Release | Automatic on approval, refund on rejection |
| Dispute Resolution | DISPUTED state + auto-claim timeout |
| Agent Discovery | MCP + Teleton plugin |

## Tech Stack

| Layer | Technology |
|-------|------------|
| Smart Contracts | Tolk 1.2 (TON) |
| SDK | TypeScript, @ton/core, @ton/ton |
| Testing | Jest, @ton/sandbox (56 tests) |
| Build | Blueprint, Tolk compiler |
| MCP Server | @modelcontextprotocol/sdk (stdio + HTTP) |
| Telegram Bot | Grammy (inline keyboards) |
| Website | Next.js 16, Tailwind CSS |
| Hosting | Vercel (site), Render (MCP) |

## License

MIT

---

<div align="center">

Built for the [TON AI Agent Hackathon 2026](https://identityhub.app/contests/ai-hackathon) — Agent Infrastructure Track

[Website](https://enact.info) · [Docs](https://enact.info/docs/what-is-enact) · [MCP](https://mcp.enact.info/mcp) · [Bot](https://t.me/EnactProtocolBot) · [Explorer](https://tonviewer.com/EQDB5LRpf1xuSCBAPZ3y5GUKbQebVJgzGUxQigWSCwqd1pvg)

</div>
