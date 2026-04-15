"""Cell builder sanity checks.

These verify that each message body:
* builds without raising,
* starts with the correct opcode in the high 32 bits of the first cell,
* is deterministic across calls for fixed inputs.
"""
from __future__ import annotations

from enact_protocol.constants import FACTORY_ADDRESS, FactoryOp, JETTON_TRANSFER_OP, JobOp
from enact_protocol._internal.cells import reason_to_uint256, to_nano
from enact_protocol.wrappers import (
    build_factory_message,
    build_job_message,
    build_jetton_transfer_message,
    build_set_jetton_wallet_message,
)


from enact_protocol.constants import USDT_MASTER_ADDRESS

# Use a real mainnet address (USDT master) as a stand-in for tests — the
# address bytes don't matter for opcode assertions, only that it parses.
EVAL = USDT_MASTER_ADDRESS


def _read_op(cell) -> int:
    slc = cell.begin_parse()
    return slc.load_uint(32)


def test_to_nano_ton():
    assert to_nano("0.1") == 100_000_000
    assert to_nano("1") == 1_000_000_000
    assert to_nano("0.001") == 1_000_000
    assert to_nano("0") == 0


def test_to_nano_usdt():
    assert to_nano("5", decimals=6) == 5_000_000
    assert to_nano("0.5", decimals=6) == 500_000


def test_to_nano_int_passthrough():
    assert to_nano(12345) == 12345


def test_reason_to_uint256():
    assert reason_to_uint256(None) == 0
    assert reason_to_uint256("") == 0
    # "hi" -> 0x6869 padded with zeros
    assert reason_to_uint256("hi") == int("68690" + "0" * 59, 16)


def test_factory_create_job_opcode():
    body = build_factory_message(
        evaluator=EVAL,
        budget_nano=100_000_000,
        description_hash=0xDEADBEEF,
        timeout=86400,
        evaluation_timeout=86400,
    )
    assert _read_op(body) == FactoryOp.CREATE_JOB.value


def test_job_simple_opcodes():
    for action, opcode in [
        ("fund", JobOp.FUND),
        ("take_job", JobOp.TAKE_JOB),
        ("cancel", JobOp.CANCEL),
        ("claim", JobOp.CLAIM),
        ("quit", JobOp.QUIT),
    ]:
        body = build_job_message(action)
        assert _read_op(body) == opcode.value, f"wrong opcode for {action}"


def test_job_submit_result_opcode():
    body = build_job_message(
        "submit_result", result_hash=0xCAFEBABE, result_type=1
    )
    assert _read_op(body) == JobOp.SUBMIT_RESULT.value


def test_job_evaluate_opcode():
    body = build_job_message("evaluate", approved=True, reason_hash=0xABCD)
    assert _read_op(body) == JobOp.EVALUATE.value


def test_job_set_budget_opcode():
    body = build_job_message("set_budget", budget_nano=200_000_000)
    assert _read_op(body) == JobOp.SET_BUDGET.value


def test_set_jetton_wallet_opcode():
    body = build_set_jetton_wallet_message(FACTORY_ADDRESS)
    assert _read_op(body) == JobOp.SET_JETTON_WALLET.value


def test_jetton_transfer_opcode():
    body = build_jetton_transfer_message(
        amount_nano=5_000_000,
        destination=FACTORY_ADDRESS,
        response_destination=FACTORY_ADDRESS,
        forward_ton_amount_nano=50_000_000,
    )
    assert _read_op(body) == JETTON_TRANSFER_OP


def test_ipfs_hash_matches_json_stringify_for_ascii():
    """Verify SHA-256 hash matches what NPM's JSON.stringify would produce."""
    import hashlib

    from enact_protocol.ipfs import compute_uint256_hash

    # JSON.stringify({"a":1,"b":"x"}) in JS produces exactly this string.
    js_equivalent = '{"a":1,"b":"x"}'
    expected = int.from_bytes(
        hashlib.sha256(js_equivalent.encode("utf-8")).digest(), "big"
    )
    assert compute_uint256_hash({"a": 1, "b": "x"}) == expected


def test_ipfs_hash_matches_json_stringify_for_cyrillic():
    """Non-ASCII must be \\uXXXX-escaped to match JS JSON.stringify byte-for-byte.

    This is the advisor-caught v0.1.1 regression: ``ensure_ascii=False`` would
    emit raw UTF-8 bytes, producing a different hash than NPM SDK for any
    description with Cyrillic / emoji / CJK.
    """
    import hashlib

    from enact_protocol.ipfs import compute_uint256_hash

    # JSON.stringify({"desc":"Тест"}) in JS produces exactly:
    # '{"desc":"\\u0422\\u0435\\u0441\\u0442"}'
    js_equivalent = r'{"desc":"\u0422\u0435\u0441\u0442"}'
    expected = int.from_bytes(
        hashlib.sha256(js_equivalent.encode("utf-8")).digest(), "big"
    )
    assert compute_uint256_hash({"desc": "Тест"}) == expected


def test_bodies_are_deterministic():
    """Same inputs must produce byte-identical bodies (no random nonces here)."""
    a = build_job_message("fund")
    b = build_job_message("fund")
    assert a.to_boc() == b.to_boc()

    a = build_factory_message(
        evaluator=EVAL,
        budget_nano=1_000_000,
        description_hash=42,
        timeout=3600,
        evaluation_timeout=3600,
    )
    b = build_factory_message(
        evaluator=EVAL,
        budget_nano=1_000_000,
        description_hash=42,
        timeout=3600,
        evaluation_timeout=3600,
    )
    assert a.to_boc() == b.to_boc()
