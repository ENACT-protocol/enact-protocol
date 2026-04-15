"""Cell builders — internal helpers shared by the public ``wrappers/`` modules.

These match byte-for-byte the ``beginCell(...).endCell()`` payloads built by
``@ton/core`` in ``sdk/src/client.ts`` and ``sdk/src/wrappers/*``.
"""
from __future__ import annotations

from pytoniq_core import Address, Cell, begin_cell


def to_nano(amount: str | float | int, decimals: int = 9) -> int:
    """Convert a human-readable amount string to base units (nano).

    Mirrors ``@ton/core.toNano`` for strings and numbers. Uses decimal parsing
    so amounts like ``"0.1"`` become exactly ``100_000_000`` for ``decimals=9``.
    """
    if isinstance(amount, int):
        return amount
    if isinstance(amount, float):
        amount = f"{amount:.{decimals}f}"
    if not isinstance(amount, str):
        raise TypeError(f"amount must be str|int|float, got {type(amount)!r}")
    sign = 1
    if amount.startswith("-"):
        sign = -1
        amount = amount[1:]
    if "." in amount:
        whole, frac = amount.split(".", 1)
    else:
        whole, frac = amount, ""
    frac = (frac + "0" * decimals)[:decimals]
    return sign * (int(whole or "0") * (10 ** decimals) + int(frac or "0"))


def reason_to_uint256(reason: str | None) -> int:
    """Fallback encoding for ``evaluate_job`` reason when Pinata isn't configured.

    Mirrors the NPM SDK: hex-encode the reason text, pad to 64 hex chars, take
    the first 64 chars, parse as uint256.
    """
    if not reason:
        return 0
    hex_str = reason.encode("utf-8").hex()
    hex_str = hex_str.ljust(64, "0")[:64]
    return int(hex_str, 16)


def build_create_job_body(
    *,
    create_op: int,
    evaluator: str | Address,
    budget_nano: int,
    desc_hash: int,
    timeout: int,
    eval_timeout: int,
) -> Cell:
    eval_addr = evaluator if isinstance(evaluator, Address) else Address(evaluator)
    return (
        begin_cell()
        .store_uint(create_op, 32)
        .store_address(eval_addr)
        .store_coins(budget_nano)
        .store_uint(desc_hash, 256)
        .store_uint(timeout, 32)
        .store_uint(eval_timeout, 32)
        .end_cell()
    )


def build_simple_op_body(op: int) -> Cell:
    """No-arg opcode body: fund / take / cancel / claim / quit."""
    return begin_cell().store_uint(op, 32).end_cell()


def build_submit_result_body(
    *, op: int, result_hash: int, result_type: int = 0
) -> Cell:
    return (
        begin_cell()
        .store_uint(op, 32)
        .store_uint(result_hash, 256)
        .store_uint(result_type, 8)
        .end_cell()
    )


def build_evaluate_body(*, op: int, approved: bool, reason_hash: int) -> Cell:
    return (
        begin_cell()
        .store_uint(op, 32)
        .store_uint(1 if approved else 0, 8)
        .store_uint(reason_hash, 256)
        .end_cell()
    )


def build_set_budget_body(*, op: int, budget_nano: int) -> Cell:
    return (
        begin_cell()
        .store_uint(op, 32)
        .store_coins(budget_nano)
        .end_cell()
    )


def build_set_jetton_wallet_body(*, op: int, jetton_wallet: Address) -> Cell:
    return (
        begin_cell()
        .store_uint(op, 32)
        .store_address(jetton_wallet)
        .end_cell()
    )


def build_jetton_transfer_body(
    *,
    transfer_op: int,
    query_id: int,
    amount_nano: int,
    destination: Address,
    response_destination: Address,
    forward_ton_amount_nano: int,
    forward_payload: Cell | None = None,
) -> Cell:
    """TEP-74 jetton transfer payload (opcode 0x0f8a7ea5)."""
    b = (
        begin_cell()
        .store_uint(transfer_op, 32)
        .store_uint(query_id, 64)
        .store_coins(amount_nano)
        .store_address(destination)
        .store_address(response_destination)
        .store_bit_int(0)
        .store_coins(forward_ton_amount_nano)
    )
    payload = forward_payload if forward_payload is not None else begin_cell().store_uint(0, 32).end_cell()
    b = b.store_bit_int(1).store_ref(payload)
    return b.end_cell()


def address_slice(address: Address) -> Cell:
    """Encode an address as a 1-cell slice, for ``runMethod`` slice args."""
    return begin_cell().store_address(address).end_cell()


__all__ = [
    "to_nano",
    "reason_to_uint256",
    "build_create_job_body",
    "build_simple_op_body",
    "build_submit_result_body",
    "build_evaluate_body",
    "build_set_budget_body",
    "build_set_jetton_wallet_body",
    "build_jetton_transfer_body",
    "address_slice",
]
