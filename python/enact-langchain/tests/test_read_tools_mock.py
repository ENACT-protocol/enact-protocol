"""Async tool tests with a mocked EnactClient.

Verifies the wiring: every read tool calls the right SDK method and returns
a JSON-stringified representation that an LLM can parse.
"""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from enact_langchain import (
    GetJobCountTool,
    GetJobStatusTool,
    GetWalletAddressTool,
    ListJobsTool,
)
from enact_protocol import EnactClient, JobData, JobListItem


def _client_with(method_name: str, return_value):
    # spec=EnactClient so pydantic's isinstance check in BaseTool passes.
    c = MagicMock(spec=EnactClient)
    setattr(c, method_name, AsyncMock(return_value=return_value))
    return c


async def test_get_wallet_address_tool():
    tool = GetWalletAddressTool(client=_client_with("get_wallet_address", "UQtest"))
    result = await tool._arun()
    assert result == "UQtest"


async def test_get_job_count_tool():
    tool = GetJobCountTool(client=_client_with("get_job_count", 42))
    result = await tool._arun()
    assert result == "42"


async def test_list_jobs_tool():
    items = [
        JobListItem(job_id=0, address="EQ_A", type="ton"),
        JobListItem(job_id=1, address="EQ_B", type="ton"),
    ]
    tool = ListJobsTool(client=_client_with("list_jobs", items))
    result = await tool._arun()
    parsed = json.loads(result)
    assert len(parsed) == 2
    assert parsed[0]["job_id"] == 0
    assert parsed[0]["address"] == "EQ_A"


async def test_get_job_status_tool_returns_json():
    status = JobData.from_fields(
        job_id=7,
        state=3,
        address="EQ_X",
        client_addr="UQ_C",
        provider_addr="UQ_P",
        evaluator_addr="UQ_E",
        budget=100_000_000,
        desc_hash_int=0xABCD,
        result_hash_int=0,
        reason_hash_int=0,
        timeout=86400,
        created_at=1700000000,
        eval_timeout=86400,
        submitted_at=1700001000,
    )
    tool = GetJobStatusTool(client=_client_with("get_job_status", status))
    result = await tool._arun(job_address="EQ_X")
    parsed = json.loads(result)
    assert parsed["job_id"] == 7
    assert parsed["state_name"] == "COMPLETED"
    assert parsed["budget_ton"] == "0.1000"


async def test_sync_facade_outside_loop():
    """_run works from no-loop contexts (blocking caller)."""
    import asyncio

    tool = GetJobCountTool(client=_client_with("get_job_count", 3))

    def call_sync():
        return tool._run()

    # Run in a worker thread so we don't have a running loop in it.
    result = await asyncio.get_running_loop().run_in_executor(None, call_sync)
    assert result == "3"


async def test_sync_facade_inside_loop_raises():
    """Using the sync facade while a loop is running is an error."""
    tool = GetJobCountTool(client=_client_with("get_job_count", 0))
    with pytest.raises(RuntimeError, match="running event loop"):
        tool._run()
