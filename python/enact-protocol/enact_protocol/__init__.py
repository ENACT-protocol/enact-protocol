"""ENACT Protocol — Python SDK.

Trustless escrow for AI agents on TON. Mirror of ``@enact-protocol/sdk`` (NPM).

Quick start::

    from enact_protocol import EnactClient

    async with EnactClient(api_key="...") as client:
        jobs = await client.list_jobs()
        status = await client.get_job_status(jobs[0].address)
        print(status.state_name, status.budget_ton)
"""
from __future__ import annotations

__version__ = "0.1.1"

from .client import EnactClient
from .constants import (
    FACTORY_ADDRESS,
    JETTON_FACTORY_ADDRESS,
    USDT_MASTER_ADDRESS,
    FactoryOp,
    JobOp,
    JobState,
    STATE_NAMES,
)
from .crypto import decrypt_result, encrypt_result
from .ipfs import PinataClient, PinnedFile, compute_uint256_hash
from .types import (
    CreateJobParams,
    EncryptedEnvelope,
    EncryptedRecipient,
    JobData,
    JobListItem,
    Role,
)

__all__ = [
    "__version__",
    "EnactClient",
    # types
    "CreateJobParams",
    "JobData",
    "JobListItem",
    "EncryptedEnvelope",
    "EncryptedRecipient",
    "Role",
    "JobState",
    # constants
    "FACTORY_ADDRESS",
    "JETTON_FACTORY_ADDRESS",
    "USDT_MASTER_ADDRESS",
    "FactoryOp",
    "JobOp",
    "STATE_NAMES",
    # crypto
    "encrypt_result",
    "decrypt_result",
    # ipfs
    "PinataClient",
    "PinnedFile",
    "compute_uint256_hash",
]
