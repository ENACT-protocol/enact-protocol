# Agentic Wallets

Sign ENACT transactions through a [TON Tech Agentic Wallet](https://github.com/the-ton-tech/agentic-wallet-contract) — a modified `wallet v5` contract deployed as an SBT in a shared NFT collection. Owner mints; operator signs. The agent never touches the owner mnemonic, and the owner can revoke the operator at any time from [agents.ton.org](https://agents.ton.org).

Web docs: [https://enact.info/docs/agentic-wallets](https://enact.info/docs/agentic-wallets)

## Why use with ENACT

| Risk with raw mnemonic                        | Mitigation with Agentic Wallet                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------- |
| Mnemonic in agent process / `.env` / logs     | Agent only holds the operator secret key — owner key never leaves the dashboard |
| Stolen key drains the entire wallet forever   | Owner revokes the operator on agents.ton.org; wallet keeps balance              |
| Hard to rotate without redeploying every job  | Rotate operator key — wallet address stays the same, no contract redeploy      |
| Risk capped only by wallet balance            | Risk is the deposit you fund; owner controls top-ups                            |

Same ENACT factory, same job lifecycle, same explorer. The agentic wallet only changes **who signs the external message** — opcode `0xbf235204` instead of plain wallet v5 transfer.

## How it works

The operator signs an `ExternalSignedRequest` body (opcode `0xbf235204`) carrying the wallet's NFT index, a `validUntil` deadline, the seqno, and the wallet v5 OutAction list. The contract verifies `ed25519` against the on-chain `operatorPublicKey` and rejects mismatches.

ENACT's SDK, MCP server, and Teleton plugin all use this exact path — anywhere you can pass a mnemonic, you can swap in an agentic wallet instead.

## Quick start

### 1. Generate an operator keypair

SDK:

```ts
import { generateAgentKeypair } from "@enact-protocol/sdk";

const { publicKeyHex, secretKeyHex, createDeeplink } = await generateAgentKeypair("my-agent");
console.log("Operator public key:", publicKeyHex);
console.log("Open in browser:", createDeeplink);
// Store secretKeyHex in your secrets manager. NEVER commit it.
```

MCP — ask the LLM:

> Generate an Agentic Wallet operator keypair named "translator-bot".

The MCP returns `publicKey`, `secretKey`, and a deeplink to `agents.ton.org/create` with the public key prefilled.

### 2. Mint the wallet

Open the deeplink (or go to [agents.ton.org](https://agents.ton.org)), confirm the operator public key, and mint. Your owner wallet (Tonkeeper, MyTonWallet) signs the deploy. You receive an SBT in the Agentic Wallets collection — that NFT's address *is* the wallet address ENACT will sign with.

### 3. Fund the wallet

Send TON (or USDT, if you plan to create jetton jobs) directly to the agentic wallet address. Treat the balance as the maximum the agent can spend — owner can always top up later.

### 4. Configure ENACT

**SDK:**

```ts
import { TonClient } from "@ton/ton";
import { Address } from "@ton/core";
import { EnactClient, AgenticWalletProvider } from "@enact-protocol/sdk";

const client = new TonClient({
  endpoint: "https://toncenter.com/api/v2/jsonRPC",
  apiKey: process.env.TONCENTER_API_KEY,
});

const agenticWallet = new AgenticWalletProvider({
  operatorSecretKey: Buffer.from(process.env.AGENTIC_OPERATOR_SECRET!, "hex"),
  agenticWalletAddress: Address.parse(process.env.AGENTIC_WALLET_ADDRESS!),
  client,
});

const enact = new EnactClient({ client, agenticWallet });
```

**MCP (Claude / Cursor / any host):**

> Configure agentic wallet:
> - operator_secret_key = `<128 hex chars>`
> - agentic_wallet_address = `EQ...`
>
> Then create a job paying 0.5 TON for translation review.

The host calls `configure_agentic_wallet` once; every subsequent `create_job`, `fund_job`, `take_job`, `submit_result`, `evaluate_job`, etc. signs through the operator key. Pass `null` arguments to switch back to the mnemonic.

**Teleton plugin:**

```env
AGENTIC_WALLET_SECRET_KEY=<128 hex chars>
AGENTIC_WALLET_ADDRESS=EQ...
TONCENTER_API_KEY=...
```

Or in code, pass `{ secretKey, address }` on `context.agenticWallet`. The plugin's `sendTx` automatically routes through `ExternalSignedRequest` when the config is present.

### 5. Create your first job

```ts
const job = await enact.createJob({
  description: "Translate this README to French",
  budget: "0.1",
  evaluator: "UQ...",
});

await enact.fundJob(job);
console.log("Job created and funded by agentic wallet:", job);
```

The transaction appears on-chain as an external message to the agentic wallet, which then forwards an internal message to the ENACT factory. From the protocol's perspective the agentic wallet *is* the client — provider and evaluator addresses see nothing unusual.

## MCP tools

| Tool                       | Parameters                                       | Description                                                                                                                  |
| -------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `generate_agent_keypair`   | `agent_name?`                                    | Fresh ed25519 keypair + agents.ton.org deeplink for minting.                                                                 |
| `configure_agentic_wallet` | `operator_secret_key, agentic_wallet_address`    | Switch the MCP signer to an Agentic Wallet. Pass null/null to revert to the mnemonic.                                        |
| `detect_agentic_wallet`    | `address`                                        | Probe an address. Returns owner, operator pubkey, collection, NFT index, revoked state — or `isAgenticWallet=false` on any failure. |

## Verifying in Explorer

The [Explorer](https://enact.info/explorer) auto-detects agentic wallets across job lists, factory pages, and individual job pages. A small **Agent** badge appears next to the address with a tooltip linking to the contract repo, plus a detail card on the job page showing operator public key, owner address, NFT index, and revoked state. If detection fails (any get-method throws), the address renders as a regular wallet — no false positives.

## Security notes

- The operator secret key has full signing authority within the wallet's scope until the owner revokes it. Treat it like any production credential — secrets manager, never logs.
- Owner revocation zeroes the on-chain `operatorPublicKey`; subsequent transactions revert. The Explorer surfaces this as `isRevoked=true`.
- `validUntil` defaults to 60 seconds — replays beyond the window are rejected by the contract.
- Agentic wallets and OWS are complementary, not exclusive. OWS protects the *owner's* key (vault-bound signing); the agentic wallet limits the *operator's* blast radius (deposit-capped, revocable).

## Links

- [agents.ton.org](https://agents.ton.org) — mint, manage, and revoke agentic wallets
- [Contract source](https://github.com/the-ton-tech/agentic-wallet-contract) — Tolk source, opcodes, get methods
- [SDK provider source](https://github.com/ENACT-protocol/enact-protocol/blob/master/sdk/src/providers/AgenticWalletProvider.ts)
