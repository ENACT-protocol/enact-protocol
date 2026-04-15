"""Pydantic input schemas — one per tool.

Kept in a separate module so ``tools.py`` stays focused on BaseTool plumbing.
"""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field


class NoArgs(BaseModel):
    """Schema for zero-arg tools."""


class JobAddressArgs(BaseModel):
    job_address: str = Field(
        ..., description="Job contract address on TON (starts with EQ or UQ)."
    )


class GetJobAddressArgs(BaseModel):
    job_id: int = Field(..., description="Zero-indexed job id within the factory.")
    jetton: bool = Field(
        False,
        description="True to look up a USDT job; false (default) for a TON job.",
    )


class GetWalletPublicKeyArgs(BaseModel):
    address: Optional[str] = Field(
        None,
        description="Wallet address to read the ed25519 public key from. "
        "Omit to use the configured wallet.",
    )


class CreateJobArgs(BaseModel):
    description: str = Field(..., description="Job description; uploaded to IPFS.")
    budget: str = Field(
        ..., description="Budget as a decimal string in TON (e.g. '0.1')."
    )
    evaluator: str = Field(
        ..., description="TON address of the evaluator for this job."
    )
    timeout: int = Field(86400, description="Timeout in seconds.")
    eval_timeout: Optional[int] = Field(
        None, description="Evaluation timeout in seconds. Defaults to timeout."
    )


class CreateJettonJobArgs(CreateJobArgs):
    budget: str = Field(
        ..., description="Budget as a decimal string in USDT (e.g. '5')."
    )


class FundJobArgs(JobAddressArgs):
    pass


class SubmitResultArgs(JobAddressArgs):
    result: str = Field(..., description="Result text; uploaded to IPFS.")


class SubmitEncryptedResultArgs(JobAddressArgs):
    result: str = Field(
        ...,
        description="Plaintext result. E2E-encrypted so only client+evaluator can read.",
    )
    client_public_key_hex: str = Field(
        ..., description="Client ed25519 public key, hex (64 chars)."
    )
    evaluator_public_key_hex: str = Field(
        ..., description="Evaluator ed25519 public key, hex (64 chars)."
    )


class DecryptJobResultArgs(BaseModel):
    envelope_json: str = Field(
        ...,
        description="Encrypted envelope JSON string as stored on IPFS "
        "(type=job_result_encrypted).",
    )
    role: Literal["client", "evaluator"] = Field(
        ..., description="Your role on the job."
    )


class EvaluateJobArgs(JobAddressArgs):
    approved: bool = Field(
        ..., description="True to approve and pay the provider; false to reject."
    )
    reason: Optional[str] = Field(
        None, description="Optional reason. Uploaded to IPFS if Pinata is configured."
    )


class SetBudgetArgs(JobAddressArgs):
    budget: str = Field(..., description="New budget in TON (decimal string).")


__all__ = [
    "NoArgs",
    "JobAddressArgs",
    "GetJobAddressArgs",
    "GetWalletPublicKeyArgs",
    "CreateJobArgs",
    "CreateJettonJobArgs",
    "FundJobArgs",
    "SubmitResultArgs",
    "SubmitEncryptedResultArgs",
    "DecryptJobResultArgs",
    "EvaluateJobArgs",
    "SetBudgetArgs",
]
