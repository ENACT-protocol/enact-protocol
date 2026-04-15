"""Pydantic v2 types for ENACT Protocol SDK.

Mirrors the TypeScript interfaces from ``sdk/src/client.ts`` and ``sdk/src/crypto.ts``.
Field names are snake_case; a few formatting helpers (``budget_ton``) match the NPM
SDK's human-readable fields exactly.
"""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

from .constants import JobState, STATE_NAMES

Role = Literal["client", "evaluator"]


class CreateJobParams(BaseModel):
    """Parameters for ``EnactClient.create_job`` / ``create_jetton_job``.

    ``budget`` is a decimal string: for TON jobs it's TON ("0.1"), for jetton jobs
    it's USDT ("5"). The SDK converts to nanoTON / nanoUSDT internally.
    """

    model_config = ConfigDict(arbitrary_types_allowed=True)

    description: str
    budget: str
    evaluator: str
    timeout: int = 86400
    eval_timeout: Optional[int] = None
    file: Optional[tuple[bytes, str]] = None  # (buffer, filename)


class JobListItem(BaseModel):
    job_id: int
    address: str
    type: Literal["ton", "usdt"]


class JobData(BaseModel):
    """Snapshot of a job contract state.

    ``budget`` is in nano-units (nanoTON for TON jobs, nanoUSDT for jetton jobs).
    ``budget_ton`` is a display string formatted as ``"0.1234"``, kept for
    parity with the NPM SDK.
    """

    job_id: int
    state: int
    state_name: str
    address: str

    client: str
    provider: Optional[str]
    evaluator: str

    budget: int
    budget_ton: str

    desc_hash: str  # 64-char hex (256-bit)
    result_hash: str
    reason_hash: str

    timeout: int
    created_at: int
    eval_timeout: int
    submitted_at: int

    @classmethod
    def from_fields(
        cls,
        *,
        job_id: int,
        state: int,
        address: str,
        client_addr: str,
        provider_addr: Optional[str],
        evaluator_addr: str,
        budget: int,
        desc_hash_int: int,
        result_hash_int: int,
        reason_hash_int: int,
        timeout: int,
        created_at: int,
        eval_timeout: int,
        submitted_at: int,
        decimals: int = 9,
    ) -> "JobData":
        display = f"{budget / (10 ** decimals):.4f}"
        state_name = STATE_NAMES[state] if 0 <= state < len(STATE_NAMES) else f"UNKNOWN({state})"
        return cls(
            job_id=job_id,
            state=state,
            state_name=state_name,
            address=address,
            client=client_addr,
            provider=provider_addr,
            evaluator=evaluator_addr,
            budget=budget,
            budget_ton=display,
            desc_hash=f"{desc_hash_int:064x}",
            result_hash=f"{result_hash_int:064x}",
            reason_hash=f"{reason_hash_int:064x}",
            timeout=timeout,
            created_at=created_at,
            eval_timeout=eval_timeout,
            submitted_at=submitted_at,
        )


class EncryptedRecipient(BaseModel):
    role: Role
    encrypted_key: str = Field(alias="encryptedKey")
    nonce: str

    model_config = ConfigDict(populate_by_name=True)


class EncryptedEnvelope(BaseModel):
    """E2E-encrypted job result envelope.

    Wire format matches ``sdk/src/crypto.ts`` exactly. Serialized via
    ``model_dump(by_alias=True)`` for cross-SDK compatibility: field names on the
    wire are camelCase (``senderPublicKey``, ``encryptedKey``, ``submittedAt``).
    """

    type: Literal["job_result_encrypted"] = "job_result_encrypted"
    version: Literal[1] = 1
    sender_public_key: str = Field(alias="senderPublicKey")
    recipients: list[EncryptedRecipient]
    ciphertext: str
    nonce: str
    submitted_at: str = Field(alias="submittedAt")

    model_config = ConfigDict(populate_by_name=True)


__all__ = [
    "Role",
    "JobState",
    "CreateJobParams",
    "JobListItem",
    "JobData",
    "EncryptedRecipient",
    "EncryptedEnvelope",
]
