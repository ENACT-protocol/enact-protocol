"""E2E encryption for job results.

Port of ``sdk/src/crypto.ts``. Same algorithm (ed25519 -> x25519 via libsodium,
``crypto_secretbox`` for payload, ``crypto_box`` wrap per recipient), same wire
format, so envelopes written by the NPM SDK decrypt here and vice versa.

PyNaCl exposes the conversion natively via ``crypto_sign_ed25519_sk_to_curve25519``
and ``crypto_sign_ed25519_pk_to_curve25519``, so there is no need for an
``ed2curve`` port.
"""
from __future__ import annotations

import base64
from datetime import datetime, timezone
from typing import Mapping

from nacl.bindings import (
    crypto_box,
    crypto_box_NONCEBYTES,
    crypto_box_open,
    crypto_secretbox,
    crypto_secretbox_KEYBYTES,
    crypto_secretbox_NONCEBYTES,
    crypto_secretbox_open,
    crypto_sign_ed25519_pk_to_curve25519,
    crypto_sign_ed25519_sk_to_curve25519,
)
from nacl.utils import random as nacl_random

from .types import EncryptedEnvelope, EncryptedRecipient, Role


def encrypt_result(
    result: str,
    sender_secret_key: bytes,
    sender_public_key: bytes,
    recipient_public_keys: Mapping[Role, bytes],
) -> EncryptedEnvelope:
    """Encrypt ``result`` for the ``client`` and ``evaluator`` roles.

    ``sender_secret_key`` is the 64-byte NaCl ed25519 secret key (seed||pubkey),
    as produced by ``pytoniq_core.crypto.keys.mnemonic_to_private_key``.
    """
    if len(sender_secret_key) != 64:
        raise ValueError("sender_secret_key must be 64 bytes (ed25519 sk||pk)")
    if len(sender_public_key) != 32:
        raise ValueError("sender_public_key must be 32 bytes (ed25519 pk)")
    for role in ("client", "evaluator"):
        if role not in recipient_public_keys:
            raise ValueError(f"Missing recipient public key for role: {role}")

    sender_x25519_sec = crypto_sign_ed25519_sk_to_curve25519(sender_secret_key)

    secret_key = nacl_random(crypto_secretbox_KEYBYTES)
    nonce = nacl_random(crypto_secretbox_NONCEBYTES)
    ciphertext = crypto_secretbox(result.encode("utf-8"), nonce, secret_key)

    recipients: list[EncryptedRecipient] = []
    for role in ("client", "evaluator"):
        pk = recipient_public_keys[role]
        if len(pk) != 32:
            raise ValueError(f"{role} public key must be 32 bytes (ed25519 pk)")
        recipient_x25519_pub = crypto_sign_ed25519_pk_to_curve25519(pk)
        box_nonce = nacl_random(crypto_box_NONCEBYTES)
        encrypted_key = crypto_box(
            secret_key, box_nonce, recipient_x25519_pub, sender_x25519_sec
        )
        recipients.append(
            EncryptedRecipient(
                role=role,  # type: ignore[arg-type]
                encrypted_key=base64.b64encode(encrypted_key).decode("ascii"),
                nonce=base64.b64encode(box_nonce).decode("ascii"),
            )
        )

    return EncryptedEnvelope(
        type="job_result_encrypted",
        version=1,
        sender_public_key=sender_public_key.hex(),
        recipients=recipients,
        ciphertext=base64.b64encode(ciphertext).decode("ascii"),
        nonce=base64.b64encode(nonce).decode("ascii"),
        submitted_at=datetime.now(timezone.utc).isoformat(),
    )


def decrypt_result(
    envelope: EncryptedEnvelope,
    role: Role,
    recipient_secret_key: bytes,
) -> str:
    """Decrypt ``envelope`` using the recipient's 64-byte ed25519 secret key."""
    if len(recipient_secret_key) != 64:
        raise ValueError("recipient_secret_key must be 64 bytes (ed25519 sk||pk)")

    recipient = next((r for r in envelope.recipients if r.role == role), None)
    if recipient is None:
        raise ValueError(f"No encrypted key for role: {role}")

    recipient_x25519_sec = crypto_sign_ed25519_sk_to_curve25519(recipient_secret_key)
    sender_ed_pub = bytes.fromhex(envelope.sender_public_key)
    if len(sender_ed_pub) != 32:
        raise ValueError("sender_public_key in envelope must be 32 bytes hex")
    sender_x25519_pub = crypto_sign_ed25519_pk_to_curve25519(sender_ed_pub)

    encrypted_key = base64.b64decode(recipient.encrypted_key)
    box_nonce = base64.b64decode(recipient.nonce)
    secret_key = crypto_box_open(
        encrypted_key, box_nonce, sender_x25519_pub, recipient_x25519_sec
    )

    ciphertext = base64.b64decode(envelope.ciphertext)
    nonce = base64.b64decode(envelope.nonce)
    plaintext = crypto_secretbox_open(ciphertext, nonce, secret_key)
    return plaintext.decode("utf-8")


__all__ = ["encrypt_result", "decrypt_result"]
