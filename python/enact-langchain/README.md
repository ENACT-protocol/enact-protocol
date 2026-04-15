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

**Read (9):**
`enact_get_wallet_address`, `enact_get_job_count`, `enact_get_jetton_job_count`,
`enact_get_job_address`, `enact_list_jobs`, `enact_list_jetton_jobs`,
`enact_get_job_status`, `enact_get_wallet_public_key`, `enact_decrypt_job_result`.

**Write TON (10):**
`enact_create_job`, `enact_fund_job`, `enact_take_job`, `enact_submit_result`,
`enact_submit_encrypted_result`, `enact_evaluate_job`, `enact_cancel_job`,
`enact_claim_job`, `enact_quit_job`, `enact_set_budget`.

**Write USDT (3):**
`enact_create_jetton_job`, `enact_set_jetton_wallet`, `enact_fund_jetton_job`.

## Links

- Docs: https://enact.info/docs/langchain
- Core SDK: https://pypi.org/project/enact-protocol/
- Source: https://github.com/ENACT-protocol/enact-protocol

## License

MIT
