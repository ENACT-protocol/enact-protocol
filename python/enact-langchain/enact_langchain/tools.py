"""LangChain ``BaseTool`` wrappers around :class:`enact_protocol.EnactClient`.

Every tool exposes one SDK method. Tools share a small ``EnactToolBase`` mixin
that:

* holds a reference to the ``EnactClient`` (a pydantic field with
  ``arbitrary_types_allowed``),
* implements ``_run`` as a fallback that calls ``asyncio.run(self._arun(...))``
  when there is no running loop, and raises a helpful error otherwise.

Tool outputs are always JSON strings, never raw Python objects, so LLMs can
parse them consistently.
"""
from __future__ import annotations

import asyncio
import json
from typing import Any, ClassVar, Literal, Optional, Type

from enact_protocol import EnactClient
from enact_protocol.types import CreateJobParams, EncryptedEnvelope
from langchain_core.tools import BaseTool
from pydantic import BaseModel, ConfigDict

from ._schemas import (
    CreateJettonJobArgs,
    CreateJobArgs,
    DecryptJobResultArgs,
    EvaluateJobArgs,
    FundJobArgs,
    GetJobAddressArgs,
    GetWalletPublicKeyArgs,
    JobAddressArgs,
    NoArgs,
    SetBudgetArgs,
    SubmitEncryptedResultArgs,
    SubmitResultArgs,
)


def _json_dump(obj: Any) -> str:
    if hasattr(obj, "model_dump"):
        return obj.model_dump_json()
    if isinstance(obj, list) and obj and hasattr(obj[0], "model_dump"):
        return json.dumps([i.model_dump() for i in obj], ensure_ascii=False)
    return json.dumps(obj, ensure_ascii=False, default=str)


class EnactToolBase(BaseTool):
    """Shared base for every ENACT tool.

    Subclasses set ``name``, ``description``, ``args_schema`` and implement
    ``_arun``. ``_run`` is handled here as a sync facade.
    """

    model_config = ConfigDict(arbitrary_types_allowed=True)

    client: EnactClient
    is_write: ClassVar[bool] = False

    def _run(self, *args: Any, **kwargs: Any) -> str:
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return asyncio.run(self._arun(*args, **kwargs))
        raise RuntimeError(
            f"{type(self).__name__} was invoked from a running event loop. "
            "Use the async agent interface "
            "(AgentExecutor.ainvoke / Runnable.ainvoke) instead of the sync one."
        )


# ──────────────────────────── read tools ────────────────────────────


class GetWalletAddressTool(EnactToolBase):
    name: str = "enact_get_wallet_address"
    description: str = (
        "Return the configured wallet's user-friendly TON address. "
        "Requires a mnemonic to be configured on the EnactClient."
    )
    args_schema: Optional[Type[BaseModel]] = NoArgs

    async def _arun(self) -> str:
        return await self.client.get_wallet_address()


class GetJobCountTool(EnactToolBase):
    name: str = "enact_get_job_count"
    description: str = (
        "Return the total number of TON jobs ever created by the ENACT JobFactory."
    )
    args_schema: Optional[Type[BaseModel]] = NoArgs

    async def _arun(self) -> str:
        return str(await self.client.get_job_count())


class GetJettonJobCountTool(EnactToolBase):
    name: str = "enact_get_jetton_job_count"
    description: str = (
        "Return the total number of USDT (jetton) jobs ever created by the "
        "ENACT JettonJobFactory."
    )
    args_schema: Optional[Type[BaseModel]] = NoArgs

    async def _arun(self) -> str:
        return str(await self.client.get_jetton_job_count())


class GetJobAddressTool(EnactToolBase):
    name: str = "enact_get_job_address"
    description: str = (
        "Resolve a job's TON contract address from its numeric id. "
        "Set jetton=true for USDT jobs."
    )
    args_schema: Optional[Type[BaseModel]] = GetJobAddressArgs

    async def _arun(self, job_id: int, jetton: bool = False) -> str:
        factory = self.client.jetton_factory_address if jetton else None
        return await self.client.get_job_address(job_id, factory)


class ListJobsTool(EnactToolBase):
    name: str = "enact_list_jobs"
    description: str = (
        "List every TON job deployed by the ENACT JobFactory. "
        "Returns an array of {job_id, address, type}."
    )
    args_schema: Optional[Type[BaseModel]] = NoArgs

    async def _arun(self) -> str:
        return _json_dump(await self.client.list_jobs())


class ListJettonJobsTool(EnactToolBase):
    name: str = "enact_list_jetton_jobs"
    description: str = (
        "List every USDT job deployed by the ENACT JettonJobFactory."
    )
    args_schema: Optional[Type[BaseModel]] = NoArgs

    async def _arun(self) -> str:
        return _json_dump(await self.client.list_jetton_jobs())


class GetJobStatusTool(EnactToolBase):
    name: str = "enact_get_job_status"
    description: str = (
        "Fetch full status for a single job by TON address: state name, "
        "budget, client/provider/evaluator addresses, and the IPFS hashes of "
        "the description, result, and reason."
    )
    args_schema: Optional[Type[BaseModel]] = JobAddressArgs

    async def _arun(self, job_address: str) -> str:
        return _json_dump(await self.client.get_job_status(job_address))


class GetWalletPublicKeyTool(EnactToolBase):
    name: str = "enact_get_wallet_public_key"
    description: str = (
        "Read the ed25519 public key (hex, 64 chars) from any TON wallet "
        "address. Pass the address to look up, or omit to use the configured "
        "wallet."
    )
    args_schema: Optional[Type[BaseModel]] = GetWalletPublicKeyArgs

    async def _arun(self, address: Optional[str] = None) -> str:
        pk = await self.client.get_wallet_public_key(address)
        return pk.hex()


# ──────────────────────────── write tools (TON) ────────────────────────────


class CreateJobTool(EnactToolBase):
    name: str = "enact_create_job"
    description: str = (
        "Create a TON-budgeted job on ENACT. Sends ~0.03 TON in gas plus the "
        "budget-funding flow is a separate tool (enact_fund_job). Returns the "
        "new job contract address."
    )
    args_schema: Optional[Type[BaseModel]] = CreateJobArgs
    is_write: ClassVar[bool] = True

    async def _arun(
        self,
        description: str,
        budget: str,
        evaluator: str,
        timeout: int = 86400,
        eval_timeout: Optional[int] = None,
    ) -> str:
        return await self.client.create_job(
            CreateJobParams(
                description=description,
                budget=budget,
                evaluator=evaluator,
                timeout=timeout,
                eval_timeout=eval_timeout,
            )
        )


class FundJobTool(EnactToolBase):
    name: str = "enact_fund_job"
    description: str = (
        "Send the budgeted TON to a job contract to move it from OPEN to FUNDED."
    )
    args_schema: Optional[Type[BaseModel]] = FundJobArgs
    is_write: ClassVar[bool] = True

    async def _arun(self, job_address: str) -> str:
        await self.client.fund_job(job_address)
        return f"funded {job_address}"


class TakeJobTool(EnactToolBase):
    name: str = "enact_take_job"
    description: str = (
        "Register the configured wallet as the provider on an open job."
    )
    args_schema: Optional[Type[BaseModel]] = JobAddressArgs
    is_write: ClassVar[bool] = True

    async def _arun(self, job_address: str) -> str:
        await self.client.take_job(job_address)
        return f"took {job_address}"


class SubmitResultTool(EnactToolBase):
    name: str = "enact_submit_result"
    description: str = (
        "Provider: submit a plaintext result to a job. The result text is "
        "uploaded to IPFS and its SHA-256 is stored on-chain."
    )
    args_schema: Optional[Type[BaseModel]] = SubmitResultArgs
    is_write: ClassVar[bool] = True

    async def _arun(self, job_address: str, result: str) -> str:
        await self.client.submit_result(job_address, result)
        return f"submitted {job_address}"


class SubmitEncryptedResultTool(EnactToolBase):
    name: str = "enact_submit_encrypted_result"
    description: str = (
        "Provider: submit an E2E-encrypted result. Only the client and the "
        "evaluator (by their 32-byte ed25519 public keys) can decrypt. "
        "Use enact_get_wallet_public_key to fetch each role's pubkey first."
    )
    args_schema: Optional[Type[BaseModel]] = SubmitEncryptedResultArgs
    is_write: ClassVar[bool] = True

    async def _arun(
        self,
        job_address: str,
        result: str,
        client_public_key_hex: str,
        evaluator_public_key_hex: str,
    ) -> str:
        await self.client.submit_encrypted_result(
            job_address,
            result,
            {
                "client": bytes.fromhex(client_public_key_hex),
                "evaluator": bytes.fromhex(evaluator_public_key_hex),
            },
        )
        return f"submitted_encrypted {job_address}"


class DecryptJobResultTool(EnactToolBase):
    name: str = "enact_decrypt_job_result"
    description: str = (
        "Decrypt an encrypted envelope JSON (as stored on IPFS) using the "
        "configured wallet. Returns the plaintext result."
    )
    args_schema: Optional[Type[BaseModel]] = DecryptJobResultArgs
    is_write: ClassVar[bool] = False  # reads wallet, no transaction

    async def _arun(self, envelope_json: str, role: Literal["client", "evaluator"]) -> str:
        envelope = EncryptedEnvelope.model_validate_json(envelope_json)
        return await self.client.decrypt_job_result(envelope, role)


class EvaluateJobTool(EnactToolBase):
    name: str = "enact_evaluate_job"
    description: str = (
        "Evaluator: approve (pays provider) or reject (refunds client) a "
        "submitted result. Optional reason is uploaded to IPFS if configured."
    )
    args_schema: Optional[Type[BaseModel]] = EvaluateJobArgs
    is_write: ClassVar[bool] = True

    async def _arun(
        self,
        job_address: str,
        approved: bool,
        reason: Optional[str] = None,
    ) -> str:
        await self.client.evaluate_job(job_address, approved, reason)
        return f"evaluated {job_address} approved={approved}"


class CancelJobTool(EnactToolBase):
    name: str = "enact_cancel_job"
    description: str = "Client: cancel a job after its timeout has elapsed."
    args_schema: Optional[Type[BaseModel]] = JobAddressArgs
    is_write: ClassVar[bool] = True

    async def _arun(self, job_address: str) -> str:
        await self.client.cancel_job(job_address)
        return f"cancelled {job_address}"


class ClaimJobTool(EnactToolBase):
    name: str = "enact_claim_job"
    description: str = (
        "Provider: claim payment after the evaluation timeout has expired "
        "without an evaluator response."
    )
    args_schema: Optional[Type[BaseModel]] = JobAddressArgs
    is_write: ClassVar[bool] = True

    async def _arun(self, job_address: str) -> str:
        await self.client.claim_job(job_address)
        return f"claimed {job_address}"


class QuitJobTool(EnactToolBase):
    name: str = "enact_quit_job"
    description: str = (
        "Provider: quit a job before submitting a result. The job returns to "
        "OPEN so another provider can take it."
    )
    args_schema: Optional[Type[BaseModel]] = JobAddressArgs
    is_write: ClassVar[bool] = True

    async def _arun(self, job_address: str) -> str:
        await self.client.quit_job(job_address)
        return f"quit {job_address}"


class SetBudgetTool(EnactToolBase):
    name: str = "enact_set_budget"
    description: str = (
        "Client: update the budget of a job while it is still OPEN (before "
        "funding). Budget is in TON (decimal string)."
    )
    args_schema: Optional[Type[BaseModel]] = SetBudgetArgs
    is_write: ClassVar[bool] = True

    async def _arun(self, job_address: str, budget: str) -> str:
        await self.client.set_budget(job_address, budget)
        return f"set_budget {job_address} {budget}"


# ──────────────────────────── write tools (USDT / jetton) ────────────────────────────


class CreateJettonJobTool(EnactToolBase):
    name: str = "enact_create_jetton_job"
    description: str = (
        "Create a USDT-budgeted job. After creation you must call "
        "enact_set_jetton_wallet, then enact_fund_jetton_job."
    )
    args_schema: Optional[Type[BaseModel]] = CreateJettonJobArgs
    is_write: ClassVar[bool] = True

    async def _arun(
        self,
        description: str,
        budget: str,
        evaluator: str,
        timeout: int = 86400,
        eval_timeout: Optional[int] = None,
    ) -> str:
        return await self.client.create_jetton_job(
            CreateJobParams(
                description=description,
                budget=budget,
                evaluator=evaluator,
                timeout=timeout,
                eval_timeout=eval_timeout,
            )
        )


class SetJettonWalletTool(EnactToolBase):
    name: str = "enact_set_jetton_wallet"
    description: str = (
        "Install the USDT Jetton wallet on a USDT job. Resolves the wallet "
        "address from the USDT master automatically."
    )
    args_schema: Optional[Type[BaseModel]] = JobAddressArgs
    is_write: ClassVar[bool] = True

    async def _arun(self, job_address: str) -> str:
        await self.client.set_jetton_wallet(job_address)
        return f"set_jetton_wallet {job_address}"


class FundJettonJobTool(EnactToolBase):
    name: str = "enact_fund_jetton_job"
    description: str = (
        "Fund a USDT job by sending a TEP-74 jetton transfer from the "
        "sender's USDT wallet to the job contract."
    )
    args_schema: Optional[Type[BaseModel]] = JobAddressArgs
    is_write: ClassVar[bool] = True

    async def _arun(self, job_address: str) -> str:
        await self.client.fund_jetton_job(job_address)
        return f"funded_jetton {job_address}"


# ──────────────────────────── factory ────────────────────────────

READ_TOOL_CLASSES: list[type[EnactToolBase]] = [
    GetWalletAddressTool,
    GetJobCountTool,
    GetJettonJobCountTool,
    GetJobAddressTool,
    ListJobsTool,
    ListJettonJobsTool,
    GetJobStatusTool,
    GetWalletPublicKeyTool,
    DecryptJobResultTool,  # reads wallet, no transaction
]

WRITE_TOOL_CLASSES: list[type[EnactToolBase]] = [
    CreateJobTool,
    FundJobTool,
    TakeJobTool,
    SubmitResultTool,
    SubmitEncryptedResultTool,
    EvaluateJobTool,
    CancelJobTool,
    ClaimJobTool,
    QuitJobTool,
    SetBudgetTool,
    CreateJettonJobTool,
    SetJettonWalletTool,
    FundJettonJobTool,
]


def get_enact_tools(
    client: EnactClient, *, include_write: bool = False
) -> list[BaseTool]:
    """Return a list of ENACT tools bound to ``client``.

    By default returns only read-only tools — this is the safest option for
    autonomous agents. Pass ``include_write=True`` to add the 13 on-chain
    write tools (every one of which broadcasts a real TON transaction and
    burns real money).
    """
    classes: list[type[EnactToolBase]] = list(READ_TOOL_CLASSES)
    if include_write:
        classes += WRITE_TOOL_CLASSES
    return [cls(client=client) for cls in classes]


__all__ = [
    "EnactToolBase",
    "READ_TOOL_CLASSES",
    "WRITE_TOOL_CLASSES",
    "get_enact_tools",
    # read
    "GetWalletAddressTool",
    "GetJobCountTool",
    "GetJettonJobCountTool",
    "GetJobAddressTool",
    "ListJobsTool",
    "ListJettonJobsTool",
    "GetJobStatusTool",
    "GetWalletPublicKeyTool",
    "DecryptJobResultTool",
    # write
    "CreateJobTool",
    "FundJobTool",
    "TakeJobTool",
    "SubmitResultTool",
    "SubmitEncryptedResultTool",
    "EvaluateJobTool",
    "CancelJobTool",
    "ClaimJobTool",
    "QuitJobTool",
    "SetBudgetTool",
    "CreateJettonJobTool",
    "SetJettonWalletTool",
    "FundJettonJobTool",
]
