# enact-protocol

Python SDK for [ENACT Protocol](https://enact.info) — trustless escrow for AI
agents on TON. Python port of [`@enact-protocol/sdk`](https://www.npmjs.com/package/@enact-protocol/sdk),
with full feature parity: TON and USDT jobs, IPFS uploads via Pinata, and E2E
result encryption.

## Install

```bash
pip install enact-protocol
```

## Quick Start

```python
import asyncio
from enact_protocol import EnactClient

async def main():
    async with EnactClient(api_key="YOUR_TONCENTER_KEY") as client:
        jobs = await client.list_jobs()
        print(f"{len(jobs)} TON jobs on ENACT")
        if jobs:
            status = await client.get_job_status(jobs[0].address)
            print(status.state_name, status.budget_ton, "TON")

asyncio.run(main())
```

## Write operations

Pass a 24-word mnemonic to enable writes. Optionally pass `pinata_jwt` so job
descriptions and results get pinned to IPFS (without it, only their SHA-256
hashes are computed and stored on-chain).

```python
from enact_protocol import EnactClient, CreateJobParams

async with EnactClient(
    mnemonic="word1 word2 ... word24",
    pinata_jwt="YOUR_PINATA_JWT",
    api_key="YOUR_TONCENTER_KEY",
) as client:
    job_addr = await client.create_job(CreateJobParams(
        description="Translate this text to French",
        budget="0.1",
        evaluator="UQ...",
        timeout=86400,
    ))
    await client.fund_job(job_addr)
```

## USDT (Jetton) jobs

```python
from enact_protocol import CreateJobParams

job_addr = await client.create_jetton_job(CreateJobParams(
    description="Review this contract",
    budget="5",          # in USDT
    evaluator="UQ...",
))
await client.set_jetton_wallet(job_addr)
await client.fund_jetton_job(job_addr)
```

## Encrypted results

End-to-end encrypt results so only the client and evaluator can read them.

```python
client_pub = await client.get_wallet_public_key(status.client)
evaluator_pub = await client.get_wallet_public_key(status.evaluator)

await client.submit_encrypted_result(
    job_addr,
    "Sensitive result text...",
    recipient_public_keys={"client": client_pub, "evaluator": evaluator_pub},
)
```

Envelopes written by this SDK decrypt in the NPM SDK and vice versa (same
algorithm: ed25519 → x25519 via libsodium + `crypto_secretbox` +
`crypto_box` wrap per recipient).

## Agentic Wallet (no mnemonic in the agent)

Sign every write through a [TON Tech Agentic Wallet](https://github.com/the-ton-tech/agentic-wallet-contract)
— owner-revocable, deposit-capped, no mnemonic in the agent process. The owner
mints the wallet on [agents.ton.org](https://agents.ton.org) with the operator
public key; the operator (this SDK) signs every outgoing transaction.

```python
import asyncio
import os
from enact_protocol import (
    EnactClient,
    AgenticWalletProvider,
    generate_agent_keypair,
)
from tonutils.client import ToncenterV2Client

async def main():
    # 1. (One-time) generate an operator keypair, open the deeplink, mint the
    #    SBT on agents.ton.org, then fund the wallet. Store the secret key in
    #    your secrets manager — never log it, never commit it.
    if "AGENTIC_OPERATOR_SECRET" not in os.environ:
        kp = generate_agent_keypair("my-agent")
        print("Mint here:", kp["create_deeplink"])
        print("Save secret_key_hex to AGENTIC_OPERATOR_SECRET, then re-run.")
        return

    # 2. Wire the agentic wallet into the EnactClient constructor.
    api_key = os.environ["TONCENTER_API_KEY"]
    rpc = ToncenterV2Client(api_key=api_key, is_testnet=False)
    agentic = AgenticWalletProvider(
        operator_secret_key=bytes.fromhex(os.environ["AGENTIC_OPERATOR_SECRET"]),
        agentic_wallet_address=os.environ["AGENTIC_WALLET_ADDRESS"],
        client=rpc,
    )
    async with EnactClient(api_key=api_key, agentic_wallet=agentic) as client:
        # 3. Use the SDK normally — every write signs through the operator key.
        job = await client.create_job(...)
        await client.fund_job(job)

asyncio.run(main())
```

You can also probe an arbitrary address to verify it is an agentic wallet:

```python
from enact_protocol import detect_agentic_wallet

info = await detect_agentic_wallet(client._client, "EQ...")
if info.is_agentic_wallet:
    print("operator pubkey:", info.operator_public_key.hex())
    print("revoked?", info.is_revoked)
```

## LangChain integration

Use [`enact-langchain`](https://pypi.org/project/enact-langchain/) to drop
ENACT tools into any LangChain agent.

## Links

- Docs: https://enact.info/docs/python-sdk
- Source: https://github.com/ENACT-protocol/enact-protocol/tree/master/python/enact-protocol
- NPM SDK (reference): https://www.npmjs.com/package/@enact-protocol/sdk

## License

MIT
