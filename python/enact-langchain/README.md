# enact-langchain

LangChain tools for [ENACT Protocol](https://enact.info) — trustless escrow for
AI agents on TON. Wraps every method of
[`enact-protocol`](https://pypi.org/project/enact-protocol/) as a
`langchain_core.tools.BaseTool`.

## Install

```bash
pip install enact-langchain
```

`enact-protocol` is pulled in automatically.

## Quick Start (read-only explorer agent)

```python
import asyncio
from enact_protocol import EnactClient
from enact_langchain import get_enact_tools
from langchain_anthropic import ChatAnthropic
from langchain.agents import AgentExecutor, create_tool_calling_agent
from langchain_core.prompts import ChatPromptTemplate

async def main():
    client = EnactClient(api_key="YOUR_TONCENTER_KEY")

    tools = get_enact_tools(client)          # read-only (safe default)

    llm = ChatAnthropic(model="claude-haiku-4-5-20251001")
    prompt = ChatPromptTemplate.from_messages([
        ("system", "You are an explorer for ENACT Protocol on TON."),
        ("human", "{input}"),
        ("placeholder", "{agent_scratchpad}"),
    ])
    agent = create_tool_calling_agent(llm, tools, prompt)
    executor = AgentExecutor(agent=agent, tools=tools)

    result = await executor.ainvoke({"input": "How many TON jobs are on ENACT?"})
    print(result["output"])

    await client.close()

asyncio.run(main())
```

## Enabling write tools

Every write tool broadcasts a real TON transaction — burning real TON (and, for
jetton jobs, real USDT) on every call. Enable them explicitly:

```python
client = EnactClient(
    mnemonic="word1 word2 ... word24",
    pinata_jwt="YOUR_PINATA_JWT",
    api_key="YOUR_TONCENTER_KEY",
)
tools = get_enact_tools(client, include_write=True)   # opt-in
```

Put a human-in-the-loop check in front of any write tool in production.

## Tool catalog

**Read (11):**
`enact_get_wallet_address`, `enact_get_job_count`, `enact_get_jetton_job_count`,
`enact_get_job_address`, `enact_list_jobs`, `enact_list_jetton_jobs`,
`enact_get_job_status`, `enact_get_wallet_public_key`, `enact_decrypt_job_result`,
`enact_generate_agent_keypair`, `enact_detect_agentic_wallet`.

**Write TON (10):**
`enact_create_job`, `enact_fund_job`, `enact_take_job`, `enact_submit_result`,
`enact_submit_encrypted_result`, `enact_evaluate_job`, `enact_cancel_job`,
`enact_claim_job`, `enact_quit_job`, `enact_set_budget`.

**Write USDT (3):**
`enact_create_jetton_job`, `enact_set_jetton_wallet`, `enact_fund_jetton_job`.

## Agentic Wallets — sign every write through an operator key

ENACT-LangChain has full support for [TON Tech Agentic Wallets](https://enact.info/docs/agentic-wallets):
the agent never holds a mnemonic, the wallet owner can revoke or rotate the
operator at any time, and risk is capped by the wallet balance.

Read-only tools are wired at toolkit construction:

- `enact_generate_agent_keypair` — returns a fresh ed25519 keypair plus an
  `agents.ton.org/create` deeplink the user opens to mint the SBT.
- `enact_detect_agentic_wallet` — probes any TON address and returns owner,
  operator public key, NFT index, and revoked state. Treats a regular v5
  wallet as `is_agentic_wallet=False`.

Writes route through `AgenticWalletProvider` configured on the underlying
`EnactClient` — every `enact_create_job` / `enact_fund_job` /
`enact_submit_result` / etc. tool call signs through the operator key:

```python
import os
from enact_protocol import EnactClient, AgenticWalletProvider
from enact_langchain import get_enact_tools
from tonutils.client import ToncenterV2Client

rpc = ToncenterV2Client(api_key=os.environ["TONCENTER_API_KEY"], is_testnet=False)

agentic = AgenticWalletProvider(
    operator_secret_key=bytes.fromhex(os.environ["AGENTIC_OPERATOR_SECRET"]),
    agentic_wallet_address=os.environ["AGENTIC_WALLET_ADDRESS"],
    client=rpc,
)

async with EnactClient(
    api_key=os.environ["TONCENTER_API_KEY"],
    agentic_wallet=agentic,
    lighthouse_api_key=os.environ.get("LIGHTHOUSE_API_KEY"),
) as client:
    tools = get_enact_tools(client, include_write=True)
    # Every write tool the agent calls is signed by the operator key.
    # No mnemonic in this process — owner can revoke on agents.ton.org at any time.
```

## Links

- Docs: https://enact.info/docs/langchain
- Core SDK: https://pypi.org/project/enact-protocol/
- Source: https://github.com/ENACT-protocol/enact-protocol/tree/master/python/enact-langchain

## License

MIT
