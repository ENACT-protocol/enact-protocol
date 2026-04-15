"""Encrypt/decrypt round-trip tests.

Uses a fixed ed25519 keypair per role (seeded via ``PyNaCl.SigningKey``) so the
test is fully deterministic. Cross-SDK fixtures from the NPM SDK can be dropped
into ``tests/fixtures/envelope.json`` and verified via ``test_decrypt_fixture``.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from nacl.signing import SigningKey

from enact_protocol import EncryptedEnvelope, decrypt_result, encrypt_result


def _make_keypair(seed: bytes) -> tuple[bytes, bytes]:
    """Return (secret_key_64, public_key_32) for a deterministic seed."""
    assert len(seed) == 32
    signing = SigningKey(seed)
    public = bytes(signing.verify_key)
    # NaCl ed25519 secret key is 64 bytes: seed(32) || public(32)
    secret = seed + public
    return secret, public


def test_round_trip_client():
    sender_sk, sender_pk = _make_keypair(b"\x01" * 32)
    client_sk, client_pk = _make_keypair(b"\x02" * 32)
    evaluator_sk, evaluator_pk = _make_keypair(b"\x03" * 32)

    plaintext = "Hello from ENACT, this is a secret result."
    envelope = encrypt_result(
        plaintext,
        sender_sk,
        sender_pk,
        {"client": client_pk, "evaluator": evaluator_pk},
    )

    assert envelope.type == "job_result_encrypted"
    assert envelope.version == 1
    assert envelope.sender_public_key == sender_pk.hex()
    assert {r.role for r in envelope.recipients} == {"client", "evaluator"}

    assert decrypt_result(envelope, "client", client_sk) == plaintext
    assert decrypt_result(envelope, "evaluator", evaluator_sk) == plaintext


def test_round_trip_unicode():
    sender_sk, sender_pk = _make_keypair(b"\x04" * 32)
    client_sk, client_pk = _make_keypair(b"\x05" * 32)
    _, evaluator_pk = _make_keypair(b"\x06" * 32)

    plaintext = "Unicode: 你好世界 — эмодзи 🎉 — результат задачи"
    envelope = encrypt_result(
        plaintext,
        sender_sk,
        sender_pk,
        {"client": client_pk, "evaluator": evaluator_pk},
    )
    assert decrypt_result(envelope, "client", client_sk) == plaintext


def test_wrong_role_key_fails():
    sender_sk, sender_pk = _make_keypair(b"\x07" * 32)
    _, client_pk = _make_keypair(b"\x08" * 32)
    evaluator_sk, evaluator_pk = _make_keypair(b"\x09" * 32)
    wrong_sk, _ = _make_keypair(b"\x0a" * 32)

    envelope = encrypt_result(
        "secret",
        sender_sk,
        sender_pk,
        {"client": client_pk, "evaluator": evaluator_pk},
    )
    # Evaluator's slot, but we present the wrong secret key
    with pytest.raises(Exception):
        decrypt_result(envelope, "evaluator", wrong_sk)


def test_invalid_key_lengths():
    with pytest.raises(ValueError):
        encrypt_result(
            "x",
            sender_secret_key=b"\x00" * 32,  # should be 64
            sender_public_key=b"\x00" * 32,
            recipient_public_keys={"client": b"\x00" * 32, "evaluator": b"\x00" * 32},
        )


def test_wire_format_stable():
    """The envelope's wire JSON must use the NPM SDK's camelCase field names."""
    sender_sk, sender_pk = _make_keypair(b"\x11" * 32)
    _, client_pk = _make_keypair(b"\x12" * 32)
    _, evaluator_pk = _make_keypair(b"\x13" * 32)
    envelope = encrypt_result(
        "x",
        sender_sk,
        sender_pk,
        {"client": client_pk, "evaluator": evaluator_pk},
    )
    wire = envelope.model_dump(by_alias=True)
    assert wire["type"] == "job_result_encrypted"
    assert wire["version"] == 1
    assert "senderPublicKey" in wire
    assert "submittedAt" in wire
    assert wire["recipients"][0].keys() >= {"role", "encryptedKey", "nonce"}


FIXTURE_PATH = Path(__file__).parent / "fixtures" / "envelope.json"


@pytest.mark.skipif(
    not FIXTURE_PATH.exists(),
    reason="No cross-SDK fixture committed yet (optional)",
)
def test_decrypt_npm_fixture():
    """Verify an envelope produced by the NPM SDK decrypts identically.

    The fixture is expected to be a JSON object with the envelope itself under
    ``envelope``, the expected plaintext under ``plaintext``, and the
    recipient secret keys under ``clientSecretKey`` / ``evaluatorSecretKey``
    (hex, 64 bytes each).
    """
    data = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    envelope = EncryptedEnvelope.model_validate(data["envelope"])
    for role_key, role in (
        ("clientSecretKey", "client"),
        ("evaluatorSecretKey", "evaluator"),
    ):
        sk_hex = data.get(role_key)
        if not sk_hex:
            continue
        sk = bytes.fromhex(sk_hex)
        assert decrypt_result(envelope, role, sk) == data["plaintext"]
