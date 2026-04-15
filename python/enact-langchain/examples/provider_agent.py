"""Provider agent — takes open jobs and submits results.

DANGER: this agent calls write tools. Every action broadcasts a real TON
transaction and burns real TON (plus USDT for jetton jobs). Review every
call before enabling this in production.

Requires::

    pip install enact-langchain langchain langchain-anthropic

    export ANTHROPIC_API_KEY=sk-ant-...
    export TONCENTER_API_KEY=...
    export MNEMONIC="word1 word2 ... word24"
    export PINATA_JWT=...             # for uploading result to IPFS

Run::

    python examples/provider_agent.py JOB_ADDRESS
"""
from __future__ import annotations

import asyncio
import os
import sys

from enact_langchain import get_enact_tools
from enact_protocol import EnactClient
from langchain.agents import AgentExecutor, create_tool_calling_agent
from langchain_anthropic import ChatAnthropic
from langchain_core.prompts import ChatPromptTemplate


SYSTEM = """You are a provider agent on ENACT Protocol. The user will give
you one job address. Your workflow:

1. Use enact_get_job_status to inspect the job. Refuse if state is not OPEN
   or FUNDED, or if there is already a provider. Refuse if the budget looks
   suspicious.
2. Summarize the work and confirm with the user.
3. Use enact_take_job to register yourself as provider.
4. Produce a result and submit it with enact_submit_result.

Be conservative: ask before every write tool. Never submit a result you
cannot justify."""


async def main() -> None:
    if len(sys.argv) != 2:
        print("usage: python provider_agent.py JOB_ADDRESS", file=sys.stderr)
        sys.exit(2)
    job_address = sys.argv[1]

    client = EnactClient(
        api_key=os.environ.get("TONCENTER_API_KEY"),
        mnemonic=os.environ["MNEMONIC"],
        pinata_jwt=os.environ.get("PINATA_JWT"),
    )
    tools = get_enact_tools(client, include_write=True)  # OPT-IN — real txs

    llm = ChatAnthropic(model="claude-sonnet-4-6")
    prompt = ChatPromptTemplate.from_messages(
        [
            ("system", SYSTEM),
            ("human", "Job address: {input}"),
            ("placeholder", "{agent_scratchpad}"),
        ]
    )

    agent = create_tool_calling_agent(llm, tools, prompt)
    executor = AgentExecutor(agent=agent, tools=tools, verbose=True)

    result = await executor.ainvoke({"input": job_address})
    print(result["output"])

    await client.close()


if __name__ == "__main__":
    asyncio.run(main())
