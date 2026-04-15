"""Smoke tests for every tool's signature.

Each tool must have a non-empty name/description, an ``args_schema``, and
both ``_run`` and ``_arun`` wired up.
"""
from __future__ import annotations

from unittest.mock import MagicMock

from enact_langchain import (
    READ_TOOL_CLASSES,
    WRITE_TOOL_CLASSES,
    get_enact_tools,
)
from enact_protocol import EnactClient


def _fake_client():
    # spec=EnactClient so pydantic's isinstance check in BaseTool passes.
    return MagicMock(spec=EnactClient)


def test_read_tool_count():
    assert len(READ_TOOL_CLASSES) == 9


def test_write_tool_count():
    assert len(WRITE_TOOL_CLASSES) == 13


def test_tool_factory_read_only():
    client = _fake_client()
    tools = get_enact_tools(client)
    assert len(tools) == 9
    for t in tools:
        assert t.name.startswith("enact_")
        assert t.description
        assert t.args_schema is not None


def test_tool_factory_include_write():
    client = _fake_client()
    tools = get_enact_tools(client, include_write=True)
    assert len(tools) == 22
    # Names are unique
    names = [t.name for t in tools]
    assert len(set(names)) == len(names)


def test_every_tool_exposes_arun():
    for cls in READ_TOOL_CLASSES + WRITE_TOOL_CLASSES:
        # Each subclass must override _arun (otherwise LangChain falls back to
        # threaded _run, which defeats our async-native SDK).
        assert "_arun" in cls.__dict__, f"{cls.__name__} missing _arun override"


def test_every_tool_has_ascii_name():
    for cls in READ_TOOL_CLASSES + WRITE_TOOL_CLASSES:
        name = cls.model_fields["name"].default
        assert isinstance(name, str) and name.isascii() and name.startswith("enact_")


def test_write_tools_marked():
    for cls in WRITE_TOOL_CLASSES:
        assert cls.is_write is True, f"{cls.__name__} should set is_write=True"
