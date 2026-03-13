# v0 Prompt — ENACT Protocol Landing Page

Design a premium, award-winning landing page for **ENACT Protocol** — an on-chain escrow protocol that enables trustless payments between AI agents on TON blockchain. This is for a hackathon (TON AI Agent Hackathon, Track 1: Agent Infrastructure).

Think like a top-tier UI/UX designer at a crypto startup with $50M funding. I want the kind of site you'd see featured on Awwwards or Land-book. Not a generic SaaS template. Not a typical crypto landing page. Something with real identity, bold visual language, and 3D illustrations that make people stop scrolling.

## Brand & Visual Direction

- **Color palette**: Deep dark backgrounds (#050A15 range), with electric TON blue (#0098EA) as primary accent. Use subtle gradients — blue to purple to cyan. Avoid pure black, use deep navy/ink tones instead.
- **Vibe**: Futuristic but approachable. Think "AI infrastructure meets DeFi" — not cold corporate, not meme-coin chaos. Professional yet exciting.
- **3D illustrations**: Create custom 3D-style hero illustrations showing AI agents exchanging value — think floating geometric shapes, interconnected nodes, glowing orbs representing transactions, blockchain cubes with light trails. Spline/Rive aesthetic. Not stock 3D, not clip art.
- **Typography**: Use distinctive, non-standard font pairings. Something geometric and modern for headings (like Space Grotesk, Satoshi, or General Sans — NOT Inter, NOT Outfit). Monospace for code/technical elements (JetBrains Mono or similar). Big bold headings, generous whitespace.
- **Layout**: Asymmetric grids, overlapping elements, depth layers. Cards with glassmorphism + subtle noise texture. Floating elements with parallax feel. Not a boring stacked-section layout.

## Content Sections (in order)

### 1. Hero
- Big headline: **"Trustless Commerce Layer for AI Agents"**
- Subline: "On-chain escrow protocol on TON. Agents create jobs, lock funds, deliver results, get paid — no trust required."
- Two CTA buttons: "View on GitHub" + "Try Demo Bot" (links to @EnactProtocolBot on Telegram)
- Background: animated 3D scene of AI agents/nodes exchanging glowing tokens through a transparent escrow cube

### 2. Problem → Solution (short, punchy)
- Left side: "The Problem" — AI agents can't pay each other safely. Trust issues, centralized middlemen, manual settlement.
- Right side: "ENACT Solves This" — Autonomous on-chain escrow. Client locks funds → Provider works → Evaluator approves → Payment releases. Fully automated.
- Visual: split layout with contrasting treatment (dark/broken on problem side, glowing/clean on solution side)

### 3. How It Works — 4-Step Flow
Four steps as visual cards or timeline:
1. **Create & Fund** — Client creates a job, sets budget, locks TON/USDT in escrow contract
2. **Take & Execute** — Provider agent discovers the job, takes it, performs the work
3. **Submit Result** — Provider uploads result hash on-chain (SHA256 / TON Storage / IPFS)
4. **Evaluate & Pay** — Evaluator approves → funds to provider. Rejects → refund to client. Silent → auto-claim after 24h.

Below: interactive state machine diagram showing: OPEN → FUNDED → SUBMITTED → COMPLETED / DISPUTED / CANCELLED

### 4. Architecture — 4 Layers
Show as a layered 3D diagram or stacked cards with depth:
- **Layer 1: Smart Contracts** — 4 Tolk contracts (Job, JobFactory, JettonJob, JettonJobFactory). 9 opcodes, 6 states. Per-job escrow.
- **Layer 2: TypeScript SDK** — Typed wrappers for all contract operations. Build transactions programmatically.
- **Layer 3: MCP Server** — 11 tools for AI agent integration via Model Context Protocol. Claude, GPT, any MCP-compatible agent.
- **Layer 4: Integrations** — Telegram Bot (13 commands), x402 HTTP 402 bridge, Teleton autonomous agent plugin.

### 5. Stats Bar
Big numbers in a horizontal strip:
- **57** Tests Passing
- **4** Smart Contracts
- **11** MCP Tools
- **0%** Protocol Fee
- **24h** Auto-Claim
- **9** Op Codes

### 6. Key Features — 6 Cards
Each card with icon/3D element, title, description:
1. **Auto-Claim** — If evaluator stays silent, provider auto-claims after 24h. No more getting ghosted.
2. **Budget Negotiation** — Client sets/adjusts budget before funding. Provider checks price before taking. Fair discovery.
3. **Jetton (USDT) Support** — Separate JettonJob contract for stablecoin payments. Same escrow logic, Jetton transfers.
4. **x402 HTTP Payments** — AI agents pay via standard HTTP. No direct blockchain interaction needed. Web-native.
5. **Teleton Plugin** — Drop-in plugin for autonomous Telegram/TON agents. 6 ENACT tools out of the box.
6. **ERC-8183 Compatible** — First TON implementation of the Agentic Commerce standard. States, roles, evaluation — all covered.

### 7. ERC-8183 Compatibility Table
Comparison table showing ENACT vs ERC-8183 spec:
- 6 States ✓ / ✓
- 3 Roles ✓ / ✓
- On-chain escrow ✓ / ✓
- setBudget ✓ / ✓
- Jetton payments ✓ / ✓
- x402 Gasless ✓ / ✓
- Deliverable hash ✓ / ✓
- Reason on evaluate ✓ / ✓
- Auto-claim — / ✓ (ENACT exclusive)
- MCP Server — / ✓ (ENACT exclusive)
- Telegram Bot — / ✓ (ENACT exclusive)
- Teleton Plugin — / ✓ (ENACT exclusive)

### 8. Use Cases — 3 Cards
1. **Research Agent Marketplace** — AI agents buy/sell analytics, data, market analysis. Each transaction escrowed.
2. **AI Service Payments** — Pay for translations, code audits, content generation. Budget negotiation + auto-claim.
3. **Multi-Agent Coordination** — Agents delegate subtasks. Complex workflows decomposed into independent ENACT jobs.

### 9. Live Testnet
Show deployed contract addresses as clickable links with copy buttons:
- JobFactory v2: `EQCMBxz5whnqpNnT-tmbtfRPOSOsrXwNbjksOBOSbs1HXCdF`
- JettonJobFactory: `EQBSjdE6iWXNL05hY0LtbiH-P0poYN-gTn_k9PWz2xZ6O52o`
Link to testnet.tonviewer.com

### 10. Footer
- ENACT Protocol logo/wordmark
- Links: GitHub, Telegram Bot, Testnet Explorer
- "Built for TON AI Agent Hackathon 2026 — Track 1: Agent Infrastructure"
- TON logo/badge

## Technical Requirements
- Next.js / React with Tailwind CSS
- Responsive (mobile-first)
- Smooth scroll animations (intersection observer based, not scroll-jacking)
- Dark theme only (no light mode toggle needed)
- All content in one page, no routing needed

## What I DON'T want
- Generic gradient blobs that every AI startup uses
- Cookie-cutter SaaS template vibes
- Boring symmetric grid layouts
- Stock photos or generic illustrations
- Excessive animations that hurt performance
- "Web3 bro" aesthetic with neon everything
