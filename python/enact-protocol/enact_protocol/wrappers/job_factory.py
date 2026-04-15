"""JobFactory / JettonJobFactory message builders.

Port of ``sdk/src/wrappers/JobFactory.ts`` — the factory owns one message
opcode (``create_job``) which deploys a new :class:`Job` (or :class:`JettonJob`)
with the caller as the client.
"""
from __future__ import annotations

from pytoniq_core import Address, Cell

from ..constants import DEFAULT_TIMEOUT_SECONDS, FactoryOp
from .._internal.cells import build_create_job_body

__all__ = ["FactoryOp", "build_factory_message"]


def build_factory_message(
    *,
    evaluator: str | Address,
    budget_nano: int,
    description_hash: int,
    timeout: int = DEFAULT_TIMEOUT_SECONDS,
    evaluation_timeout: int | None = None,
) -> Cell:
    """Build the body for a ``create_job`` message to JobFactory / JettonJobFactory.

    Same payload shape for both factories. ``budget_nano`` is nanoTON for
    :data:`~enact_protocol.constants.FACTORY_ADDRESS` and nanoUSDT for
    :data:`~enact_protocol.constants.JETTON_FACTORY_ADDRESS`.
    """
    return build_create_job_body(
        create_op=FactoryOp.CREATE_JOB.value,
        evaluator=evaluator,
        budget_nano=budget_nano,
        desc_hash=description_hash,
        timeout=timeout,
        eval_timeout=evaluation_timeout if evaluation_timeout is not None else timeout,
    )
