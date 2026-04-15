"""Job contract message builders.

Port of ``sdk/src/wrappers/Job.ts``. One function per opcode; all return a
:class:`pytoniq_core.Cell` body ready to embed in an internal message.
"""
from __future__ import annotations

from typing import Literal

from pytoniq_core import Cell

from ..constants import JobOp
from .._internal.cells import (
    build_evaluate_body,
    build_set_budget_body,
    build_simple_op_body,
    build_submit_result_body,
)

__all__ = ["JobOp", "build_job_message"]


JobAction = Literal[
    "fund",
    "take_job",
    "submit_result",
    "evaluate",
    "cancel",
    "claim",
    "quit",
    "set_budget",
]


def build_job_message(
    action: JobAction,
    **kwargs: object,
) -> Cell:
    """Build a Job contract message body by action name.

    ``fund``, ``take_job``, ``cancel``, ``claim``, ``quit``: no extra args.
    ``submit_result``: ``result_hash: int``, optional ``result_type: int = 0``.
    ``evaluate``: ``approved: bool``, ``reason_hash: int = 0``.
    ``set_budget``: ``budget_nano: int``.
    """
    if action == "fund":
        return build_simple_op_body(JobOp.FUND.value)
    if action == "take_job":
        return build_simple_op_body(JobOp.TAKE_JOB.value)
    if action == "cancel":
        return build_simple_op_body(JobOp.CANCEL.value)
    if action == "claim":
        return build_simple_op_body(JobOp.CLAIM.value)
    if action == "quit":
        return build_simple_op_body(JobOp.QUIT.value)
    if action == "submit_result":
        result_hash = kwargs["result_hash"]
        if not isinstance(result_hash, int):
            raise TypeError("submit_result: result_hash must be int")
        result_type = kwargs.get("result_type", 0)
        if not isinstance(result_type, int):
            raise TypeError("submit_result: result_type must be int")
        return build_submit_result_body(
            op=JobOp.SUBMIT_RESULT.value,
            result_hash=result_hash,
            result_type=result_type,
        )
    if action == "evaluate":
        approved = kwargs["approved"]
        if not isinstance(approved, bool):
            raise TypeError("evaluate: approved must be bool")
        reason_hash = kwargs.get("reason_hash", 0)
        if not isinstance(reason_hash, int):
            raise TypeError("evaluate: reason_hash must be int")
        return build_evaluate_body(
            op=JobOp.EVALUATE.value,
            approved=approved,
            reason_hash=reason_hash,
        )
    if action == "set_budget":
        budget_nano = kwargs["budget_nano"]
        if not isinstance(budget_nano, int):
            raise TypeError("set_budget: budget_nano must be int")
        return build_set_budget_body(
            op=JobOp.SET_BUDGET.value,
            budget_nano=budget_nano,
        )
    raise ValueError(f"Unknown Job action: {action!r}")
