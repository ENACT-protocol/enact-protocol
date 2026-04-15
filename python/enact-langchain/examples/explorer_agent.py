"""Read-only ENACT explorer agent — safe to run without a mnemonic.

Requires::

    pip install enact-langchain langchain langchain-anthropic

    export ANTHROPIC_API_KEY=sk-ant-...
    export TONCENTER_API_KEY=...     # optional but strongly recommended

Run::

    python examples/explorer_agent.py
"""
from __future__ import annotations

import asyncio
import os

from enact_langchain import get_enact_tools
from enact_protocol import EnactClient
from langchain.agents import AgentExecutor, create_tool_calling_agent
from langchain_anthropic import ChatAnthropic
from langchain_core.prompts import ChatPromptTemplate


SYSTEM = """You are an analyst for ENACT Protocol, a TON-blockchain escrow
system for AI-agent jobs. Use the tools to answer questions about jobs,
budgets, states, and parties. Never attempt write operations — write tools
are intentionally not provided. Cite the relevant tool output when you
answer."""


async def main() -> None:
    client = EnactClient(api_key=os.environ.get("TONCENTER_API_KEY"))
    tools = get_enact_tools(client)  # read-only

    llm = ChatAnthropic(model="claude-haiku-4-5-20251001")
    prompt = ChatPromptTemplate.from_messages(
        [
            ("system", SYSTEM),
            ("human", "{input}"),
            ("placeholder", "{agent_scratchpad}"),
        ]
    )

    agent = create_tool_calling_agent(llm, tools, prompt)
    executor = AgentExecutor(agent=agent, tools=tools, verbose=True)

    questions = [
        "How many TON jobs and how many USDT jobs have been created on ENACT?",
        "What's the state of TON job #0?",
    ]
    for q in questions:
        print(f"\n=== {q} ===")
        result = await executor.ainvoke({"input": q})
        print(result["output"])

    await client.close()


if __name__ == "__main__":
    asyncio.run(main())
