"""JettonJob (USDT) contract message builders.

Port of ``sdk/src/wrappers/JettonJob.ts``. Jetton jobs mirror :class:`Job` with
two additions:

* ``set_jetton_wallet`` (opcode ``0x0a``) — called once per job to install the
  USDT Jetton wallet address.
* Funding uses a standard TEP-74 ``transfer`` (opcode ``0x0f8a7ea5``) sent to
  the sender's own Jetton wallet, not a plain TON send to the job.
"""
from __future__ import annotations

from pytoniq_core import Address, Cell

from ..constants import JETTON_TRANSFER_OP, JobOp
from .._internal.cells import build_jetton_transfer_body, build_set_jetton_wallet_body

__all__ = ["build_set_jetton_wallet_message", "build_jetton_transfer_message"]


def build_set_jetton_wallet_message(jetton_wallet: str | Address) -> Cell:
    """Body for ``set_jetton_wallet`` — sent to the JettonJob contract once."""
    addr = jetton_wallet if isinstance(jetton_wallet, Address) else Address(jetton_wallet)
    return build_set_jetton_wallet_body(
        op=JobOp.SET_JETTON_WALLET.value, jetton_wallet=addr
    )


def build_jetton_transfer_message(
    *,
    amount_nano: int,
    destination: str | Address,
    response_destination: str | Address,
    forward_ton_amount_nano: int,
    forward_payload: Cell | None = None,
    query_id: int = 0,
) -> Cell:
    """Body for a TEP-74 ``transfer`` message — sent to the sender's USDT wallet.

    ``destination`` is the job contract; ``response_destination`` is the
    sender's wallet. ``forward_payload`` defaults to a 32-bit zero (empty
    comment), matching the NPM SDK.
    """
    dest = destination if isinstance(destination, Address) else Address(destination)
    resp = (
        response_destination
        if isinstance(response_destination, Address)
        else Address(response_destination)
    )
    return build_jetton_transfer_body(
        transfer_op=JETTON_TRANSFER_OP,
        query_id=query_id,
        amount_nano=amount_nano,
        destination=dest,
        response_destination=resp,
        forward_ton_amount_nano=forward_ton_amount_nano,
        forward_payload=forward_payload,
    )
