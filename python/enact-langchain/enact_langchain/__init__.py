"""ENACT Protocol — LangChain tools.

Quick start::

    from enact_protocol import EnactClient
    from enact_langchain import get_enact_tools
    from langchain_anthropic import ChatAnthropic
    from langchain.agents import AgentExecutor, create_tool_calling_agent

    client = EnactClient(api_key="...")
    tools = get_enact_tools(client)             # read-only by default
    # tools = get_enact_tools(client, include_write=True)   # opt-in for writes

    llm = ChatAnthropic(model="claude-haiku-4-5-20251001")
    agent = create_tool_calling_agent(llm, tools, prompt)
    executor = AgentExecutor(agent=agent, tools=tools)
    await executor.ainvoke({"input": "How many TON jobs are on ENACT?"})
"""
from __future__ import annotations

__version__ = "0.1.1"

from .tools import (
    CancelJobTool,
    ClaimJobTool,
    CreateJettonJobTool,
    CreateJobTool,
    DecryptJobResultTool,
    EnactToolBase,
    EvaluateJobTool,
    FundJettonJobTool,
    FundJobTool,
    GetJettonJobCountTool,
    GetJobAddressTool,
    GetJobCountTool,
    GetJobStatusTool,
    GetWalletAddressTool,
    GetWalletPublicKeyTool,
    ListJettonJobsTool,
    ListJobsTool,
    QuitJobTool,
    READ_TOOL_CLASSES,
    SetBudgetTool,
    SetJettonWalletTool,
    SubmitEncryptedResultTool,
    SubmitResultTool,
    TakeJobTool,
    WRITE_TOOL_CLASSES,
    get_enact_tools,
)

__all__ = [
    "__version__",
    "get_enact_tools",
    "EnactToolBase",
    "READ_TOOL_CLASSES",
    "WRITE_TOOL_CLASSES",
    "GetWalletAddressTool",
    "GetJobCountTool",
    "GetJettonJobCountTool",
    "GetJobAddressTool",
    "ListJobsTool",
    "ListJettonJobsTool",
    "GetJobStatusTool",
    "GetWalletPublicKeyTool",
    "CreateJobTool",
    "FundJobTool",
    "TakeJobTool",
    "SubmitResultTool",
    "SubmitEncryptedResultTool",
    "DecryptJobResultTool",
    "EvaluateJobTool",
    "CancelJobTool",
    "ClaimJobTool",
    "QuitJobTool",
    "SetBudgetTool",
    "CreateJettonJobTool",
    "SetJettonWalletTool",
    "FundJettonJobTool",
]
