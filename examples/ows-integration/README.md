# ENACT Protocol × Open Wallet Standard (OWS)

Secure wallet integration for AI agents using [OWS](https://openwallet.sh) as the signing layer and [ENACT Protocol](https://enact.info) for trustless escrow on TON.

## What This Is

OWS and ENACT solve different problems for AI agents:

| Layer | OWS | ENACT |
|-------|-----|-------|
| **Purpose** | Key management & signing | Escrow & commerce |
| **Handles** | Private keys, policies, vault | Jobs, payments, evaluation |
| **Principle** | Keys never leave the vault | Funds never leave the contract |

Together: an AI agent can create jobs, lock funds, deliver work, and get paid — without the agent (or the LLM) ever touching a private key.

## Architecture

```
┌──────────────┐     Cell + hash     ┌──────────────┐
│  ENACT SDK   │ ──── 32 bytes ────► │  OWS Vault   │
│  constructs  │ ◄── 64-byte sig ── │  signs with  │
│  TON messages│                     │  Ed25519 key │
└──────┬───────┘                     └──────────────┘
       │
       ▼
┌──────────────┐
│  TON Network │
│  (mainnet)   │
└──────────────┘
```

The integration uses `@ton/ton`'s `signer` callback interface:

```typescript
// Instead of passing secretKey directly:
await contract.sendTransfer({ secretKey: rawKey, ... });

// OWS signs via callback — private key stays in the vault:
await contract.sendTransfer({ signer: owsSigner.sign, ... });
```

## Files

| File | Purpose |
|------|---------|
| `ows-signer.ts` | Core adapter — bridges OWS signMessage with @ton/ton signer callback |
| `demo.ts` | Full escrow lifecycle (create → fund → take → submit → evaluate) |
| `enact-policy.js` | OWS policy — restricts wallet to ENACT contracts only |
| `mcp-config.json` | ENACT MCP server config for AI agents |

## Quick Start

### Prerequisites

- Node.js 18+
- Linux or macOS (OWS native binary required — Windows not yet supported)
- `@open-wallet-standard/core` installed globally or locally

### 1. Install OWS

```bash
npm install -g @open-wallet-standard/core
```

### 2. Create Wallets

```bash
ows wallet create --name agent-client
ows wallet create --name agent-provider
ows wallet create --name agent-evaluator
```

### 3. Use the Signer

```typescript
import { TonClient, WalletContractV5R1, internal, SendMode } from '@ton/ton';
import { Address, beginCell, toNano } from '@ton/core';
import { createOWSSigner } from './ows-signer';

const signer = await createOWSSigner('agent-client');
const client = new TonClient({ endpoint: '...', apiKey: '...' });

// Create wallet contract using OWS-derived public key
const wallet = WalletContractV5R1.create({
    publicKey: signer.publicKey,
    workchain: 0,
});
const opened = client.open(wallet);
const seqno = await opened.getSeqno();

// Send transaction — OWS signs, never exposes the key
await opened.sendTransfer({
    seqno,
    signer: signer.sign,  // ← OWS callback
    sendMode: SendMode.PAY_GAS_SEPARATELY,
    messages: [internal({
        to: Address.parse('EQAFHodW...'),
        value: toNano('0.03'),
        body: beginCell().storeUint(1, 32).endCell(),
        bounce: true,
    })],
});
```

### 4. Add Policy (Optional)

```bash
chmod +x enact-policy.js
ows policy add --name enact-allowlist --executable ./enact-policy.js
```

The policy restricts the wallet to only interact with ENACT factory contracts, with a 100 TON max per transaction and 10 transactions per hour rate limit.

### 5. ENACT MCP Setup

OWS is a local CLI/SDK — it does not have a built-in MCP server. Use OWS programmatically in your agent code alongside the ENACT MCP server:

```bash
# Claude Code
claude mcp add enact-protocol https://mcp.enact.info/mcp

# Cursor — add to .cursor/mcp.json
```

Your agent uses ENACT MCP tools for job lifecycle and OWS SDK for secure transaction signing within the agent's runtime.

## How the Signer Works

### The Public Key Problem

OWS v1.1 doesn't expose public keys via API — only addresses. But `@ton/ton` needs the public key to create a `WalletContractV5R1` instance.

**Our solution:** At initialization, we call `exportWallet()` to get the mnemonic, derive the keypair using BIP-39 + SLIP-10 (the same derivation OWS uses internally), keep only the `publicKey`, and immediately zero all secret material:

```typescript
const mnemonic = ows.exportWallet(walletName);
const seed = await bip39.mnemonicToSeed(mnemonic);
const derived = derivePath("m/44'/607'/0'", seed.toString('hex'));
const keyPair = nacl.sign.keyPair.fromSeed(derived.key);
const publicKey = Buffer.from(keyPair.publicKey);
derived.key.fill(0);                    // zeroed
Buffer.from(keyPair.secretKey).fill(0); // zeroed, never used
```

**Important:** OWS uses standard BIP-39 + SLIP-10 derivation, NOT `@ton/crypto`'s `mnemonicToPrivateKey()` which uses TON-specific HMAC-based derivation. Using the wrong derivation produces a different keypair and signatures won't verify.

**Note on address compatibility:** The same 12/24-word mnemonic will produce **different TON addresses** in OWS vs Tonkeeper/MyTonWallet. This is by design — OWS is a multi-chain wallet that uses a unified BIP-39/SLIP-10 derivation path (`m/44'/607'/0'`) across all chains, while TON-native wallets use TON's own HMAC-based key derivation. An OWS wallet is a separate wallet from your Tonkeeper wallet, even if they share the same mnemonic. Fund the OWS address directly.

The private key is **never used for signing**. All signing goes through `ows.signMessage()`.

We plan to open a feature request in the OWS repository for a `getPublicKey(walletName, chainId)` method, which would eliminate the mnemonic round-trip entirely.

### Signing Flow

```
1. @ton/ton constructs the unsigned message (Cell)
2. signer callback receives the Cell
3. Cell.hash() → 32-byte SHA-256 hash
4. OWS signMessage(hash, 'hex') → 64-byte Ed25519 signature
5. Signature returned to @ton/ton for message packing
6. Signed message sent to TON network
```

## Compatibility

| Component | Version | Notes |
|-----------|---------|-------|
| OWS | 1.1.2+ | Native Rust bindings via NAPI-RS |
| @ton/ton | 16.2.2+ | WalletContractV5R1 with signer callback |
| @ton/core | ~0 | Cell, Address, beginCell |
| bip39 | 3.1.0+ | BIP-39 mnemonic to seed |
| ed25519-hd-key | 1.3.0+ | SLIP-10 Ed25519 HD derivation |
| tweetnacl | 1.0.3+ | Ed25519 keypair from seed |
| Node.js | 18+ | Required by OWS |

## Security Model

| Concern | How it's handled |
|---------|-----------------|
| Private key exposure | Keys stay in OWS vault (AES-256-GCM encrypted) |
| LLM context leakage | Private key never enters agent/LLM context |
| Unauthorized transactions | OWS policy engine evaluates BEFORE signing |
| Contract allowlist | `enact-policy.js` restricts to ENACT factories |
| Spending limits | Policy enforces max 100 TON per transaction |
| Rate limiting | Policy enforces max 10 transactions per hour |

## License

MIT — same as ENACT Protocol and OWS.
