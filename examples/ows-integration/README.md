# ENACT Protocol × Open Wallet Standard (OWS)

Secure wallet integration for AI agents using [OWS](https://openwallet.sh) as the signing layer and [ENACT Protocol](https://enact.info) for trustless escrow on TON.

**[Full documentation →](https://enact.info/docs/ows)**

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
┌──────────────┐     Cell.hash()     ┌──────────────┐
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

OWS works at the **SDK level** — it replaces the signing mechanism inside your agent code:

```typescript
// Instead of passing secretKey directly:
await contract.sendTransfer({ secretKey: rawKey, ... });

// OWS signs via callback — private key stays in the vault:
await contract.sendTransfer({ signer: owsSigner.sign, ... });
```

## How It Fits with ENACT

| Integration | Signing | Use Case |
|---|---|---|
| **ENACT SDK + OWS** | OWS vault (signer callback) | Agent code with secure local keys |
| **Local MCP + OWS** | Modify MCP server to use OWS | Local MCP with secure signing |
| **Remote MCP** | Server-side mnemonic or deeplink | Quick setup, no OWS needed |

OWS is **not related** to the remote MCP server at `mcp.enact.info` — that server has its own signing. OWS replaces signing in your own agent code via the `ows-signer.ts` adapter.

## Files

| File | Purpose |
|------|---------|
| `ows-signer.ts` | Core adapter — bridges OWS signMessage with @ton/ton signer callback |
| `demo.ts` | Full escrow lifecycle (create → fund → take → submit → evaluate) |
| `enact-policy.js` | OWS policy — value limits and rate limiting |

## Quick Start

### 1. Install OWS

```bash
npm install -g @open-wallet-standard/core
# or
curl -fsSL https://docs.openwallet.sh/install.sh | bash
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

const wallet = WalletContractV5R1.create({
    publicKey: signer.publicKey,
    workchain: 0,
});
const opened = client.open(wallet);

await opened.sendTransfer({
    seqno: await opened.getSeqno(),
    signer: signer.sign,  // ← OWS callback, not raw secretKey
    sendMode: SendMode.PAY_GAS_SEPARATELY,
    messages: [internal({
        to: Address.parse('EQAFHodW...'),
        value: toNano('0.03'),
        body: beginCell().storeUint(0x10, 32).endCell(),
        bounce: true,
    })],
});
```

### 4. Add Policy (Optional)

```bash
chmod +x enact-policy.js
ows policy create --file enact-policy.json
```

## Key Derivation

OWS uses **BIP-39 + SLIP-10** derivation at `m/44'/607'/0'`. This is different from TON-native wallets (Tonkeeper, MyTonWallet) which use TON's own HMAC-based derivation.

**Same mnemonic → different TON addresses** in OWS vs Tonkeeper. This is by design — OWS uses unified multi-chain derivation. Fund the OWS address directly.

OWS v1.1 does not expose public keys via API. The adapter derives the public key from the mnemonic at init, then zeros all secret material. See [feature request](https://github.com/open-wallet-standard/core/issues) for `getPublicKey()`.

## Compatibility

| Component | Version |
|-----------|---------|
| OWS | 1.1.2+ |
| @ton/ton | 16.2.2+ |
| @ton/core | ~0 |
| bip39 | 3.1.0+ |
| ed25519-hd-key | 1.3.0+ |
| tweetnacl | 1.0.3+ |
| Node.js | 18+ |

## Links

- [ENACT × OWS Documentation](https://enact.info/docs/ows)
- [ENACT Protocol](https://enact.info)
- [OWS Documentation](https://docs.openwallet.sh)
- [OWS GitHub](https://github.com/open-wallet-standard/core)

## License

MIT
