"""Main SDK entry point — async ``EnactClient``.

Port of ``sdk/src/client.ts``. Uses :mod:`tonutils` for the wallet + toncenter
RPC layer and :mod:`pytoniq_core` for cell / address encoding.

All write methods require a mnemonic to have been passed at construction time.
Read methods work without one. Every public method is async.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any, Literal, Mapping, Optional

from pytoniq_core import Address, Cell
from tonutils.client import ToncenterV2Client
from tonutils.wallet import WalletV5R1

from .constants import (
    DEFAULT_TIMEOUT_SECONDS,
    DEFAULT_TONCENTER_ENDPOINT,
    FACTORY_ADDRESS,
    JETTON_FACTORY_ADDRESS,
    JobOp,
    RESULT_TYPE_ENCRYPTED,
    RESULT_TYPE_PLAIN,
    TON_DECIMALS,
    USDT_DECIMALS,
    USDT_MASTER_ADDRESS,
)
from .crypto import decrypt_result as _decrypt_envelope
from .crypto import encrypt_result
from .ipfs import PinataClient
from .types import (
    CreateJobParams,
    EncryptedEnvelope,
    JobData,
    JobListItem,
    Role,
)
from .wrappers import (
    build_factory_message,
    build_jetton_transfer_message,
    build_job_message,
    build_set_jetton_wallet_message,
)
from ._internal.cells import reason_to_uint256, to_nano


class EnactClient:
    """Async client for ENACT Protocol.

    Parameters mirror the NPM ``EnactClient`` constructor options with snake_case
    names::

        client = EnactClient(
            endpoint="https://toncenter.com/api/v2/jsonRPC",
            api_key="...",
            mnemonic="word1 word2 ... word24",   # optional; required for writes
            pinata_jwt="...",                    # optional; required for IPFS uploads
        )

    Use as an async context manager to free HTTP connections::

        async with EnactClient(api_key=...) as client:
            status = await client.get_job_status(addr)
    """

    def __init__(
        self,
        *,
        endpoint: str = DEFAULT_TONCENTER_ENDPOINT,
        api_key: Optional[str] = None,
        mnemonic: Optional[str] = None,
        pinata_jwt: Optional[str] = None,
        factory_address: Optional[str] = None,
        jetton_factory_address: Optional[str] = None,
        usdt_master_address: Optional[str] = None,
    ) -> None:
        self._endpoint = endpoint
        self._api_key = api_key
        self._mnemonic = mnemonic
        self._pinata = PinataClient(pinata_jwt)
        self.factory_address = factory_address or FACTORY_ADDRESS
        self.jetton_factory_address = jetton_factory_address or JETTON_FACTORY_ADDRESS
        self.usdt_master_address = usdt_master_address or USDT_MASTER_ADDRESS

        self._client = ToncenterV2Client(
            api_key=api_key,
            is_testnet=False,
            base_url=endpoint.rsplit("/api/", 1)[0] if "/api/" in endpoint else None,
        )
        self._wallet_lock = asyncio.Lock()
        self._wallet: Optional[WalletV5R1] = None
        self._wallet_secret_key: Optional[bytes] = None
        self._wallet_public_key: Optional[bytes] = None

    async def __aenter__(self) -> "EnactClient":
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.close()

    async def close(self) -> None:
        await self._pinata.close()

    # ───────────────────────────── wallet ─────────────────────────────

    async def _ensure_wallet(self) -> WalletV5R1:
        if self._wallet is not None:
            return self._wallet
        async with self._wallet_lock:
            if self._wallet is not None:
                return self._wallet
            if not self._mnemonic:
                raise RuntimeError(
                    "Wallet not initialized. Pass mnemonic to EnactClient()."
                )
            wallet, pub, priv, _ = WalletV5R1.from_mnemonic(
                self._client, self._mnemonic
            )
            self._wallet = wallet
            self._wallet_public_key = pub
            self._wallet_secret_key = priv
            return wallet

    async def get_wallet_address(self) -> str:
        """User-friendly address (non-bounceable) for the configured wallet."""
        wallet = await self._ensure_wallet()
        return wallet.address.to_str(is_bounceable=False)

    async def get_wallet_public_key(self, address: Optional[str] = None) -> bytes:
        """Read the ed25519 public key from any wallet contract on-chain.

        Works for V3R1 / V3R2 / V4R2 / V5R1. If ``address`` is omitted, uses the
        configured wallet.
        """
        if address is None:
            await self._ensure_wallet()
            assert self._wallet_public_key is not None
            return bytes(self._wallet_public_key)
        stack = await self._client.run_get_method(
            address, "get_public_key", []
        )
        pub_int = int(stack[0])
        return pub_int.to_bytes(32, "big")

    # ───────────────────────────── reads ─────────────────────────────

    async def get_job_count(self) -> int:
        stack = await self._client.run_get_method(
            self.factory_address, "get_next_job_id", []
        )
        return int(stack[0])

    async def get_jetton_job_count(self) -> int:
        stack = await self._client.run_get_method(
            self.jetton_factory_address, "get_next_job_id", []
        )
        return int(stack[0])

    async def get_job_address(
        self, job_id: int, factory: Optional[str] = None
    ) -> str:
        target = factory or self.factory_address
        stack = await self._client.run_get_method(
            target, "get_job_address", [job_id]
        )
        addr = stack[0]
        if not isinstance(addr, Address):
            raise RuntimeError(
                f"Unexpected get_job_address response: {addr!r}"
            )
        return addr.to_str(is_bounceable=True)

    async def list_jobs(self) -> list[JobListItem]:
        return await self._list_from_factory(self.factory_address, "ton")

    async def list_jetton_jobs(self) -> list[JobListItem]:
        return await self._list_from_factory(self.jetton_factory_address, "usdt")

    async def _list_from_factory(
        self, factory: str, type_: Literal["ton", "usdt"]
    ) -> list[JobListItem]:
        count_stack = await self._client.run_get_method(
            factory, "get_next_job_id", []
        )
        count = int(count_stack[0])
        jobs: list[JobListItem] = []
        for i in range(count):
            addr_stack = await self._client.run_get_method(
                factory, "get_job_address", [i]
            )
            addr = addr_stack[0]
            if not isinstance(addr, Address):
                continue
            jobs.append(
                JobListItem(job_id=i, address=addr.to_str(is_bounceable=True), type=type_)
            )
        return jobs

    async def get_job_status(self, job_address: str) -> JobData:
        stack = await self._client.run_get_method(
            job_address, "get_job_data", []
        )
        # Stack layout from sdk/src/client.ts: jobId, client, provider?,
        # evaluator, budget, descHash, resultHash, timeout, createdAt,
        # evalTimeout, submittedAt, resultType (ignored), reason, state.
        if len(stack) < 14:
            raise RuntimeError(
                f"Unexpected get_job_data stack length: {len(stack)} (expected 14)"
            )
        job_id = int(stack[0])
        client_addr = _require_address(stack[1], "client")
        provider_addr_raw = stack[2]
        provider_addr = (
            provider_addr_raw.to_str(is_bounceable=False)
            if isinstance(provider_addr_raw, Address)
            else None
        )
        evaluator_addr = _require_address(stack[3], "evaluator")
        budget = int(stack[4])
        desc_hash = int(stack[5])
        result_hash = int(stack[6])
        timeout = int(stack[7])
        created_at = int(stack[8])
        eval_timeout = int(stack[9])
        submitted_at = int(stack[10])
        # stack[11] — resultType, ignored for API parity with NPM
        reason_hash = int(stack[12])
        state = int(stack[13])

        decimals = TON_DECIMALS  # jetton jobs also report raw nano-units; the
        # budget_ton field intentionally uses 9-decimal scaling to match
        # sdk/src/client.ts exactly, even for USDT jobs (which is the NPM
        # SDK's behaviour — USDT amounts show with TON-style scaling).

        return JobData.from_fields(
            job_id=job_id,
            state=state,
            address=job_address,
            client_addr=client_addr,
            provider_addr=provider_addr,
            evaluator_addr=evaluator_addr,
            budget=budget,
            desc_hash_int=desc_hash,
            result_hash_int=result_hash,
            reason_hash_int=reason_hash,
            timeout=timeout,
            created_at=created_at,
            eval_timeout=eval_timeout,
            submitted_at=submitted_at,
            decimals=decimals,
        )

    # ───────────────────────────── writes (TON) ─────────────────────────────

    async def create_job(self, params: CreateJobParams) -> str:
        """Create a TON-budgeted job. Returns the new job contract address."""
        count_before = await self.get_job_count()
        desc_hash = await self._upload_description(params)
        budget_nano = to_nano(params.budget, TON_DECIMALS)
        body = build_factory_message(
            evaluator=params.evaluator,
            budget_nano=budget_nano,
            description_hash=desc_hash,
            timeout=params.timeout,
            evaluation_timeout=params.eval_timeout,
        )
        await self._send(
            to=Address(self.factory_address),
            value_nano=to_nano("0.03", TON_DECIMALS),
            body=body,
        )
        count_after = await self._poll_for_count_increase(
            self.get_job_count, count_before
        )
        return await self.get_job_address(count_after - 1)

    async def fund_job(self, job_address: str) -> None:
        status = await self.get_job_status(job_address)
        body = build_job_message("fund")
        await self._send(
            to=Address(job_address),
            value_nano=status.budget + to_nano("0.01", TON_DECIMALS),
            body=body,
        )

    async def take_job(self, job_address: str) -> None:
        body = build_job_message("take_job")
        await self._send(Address(job_address), to_nano("0.01", TON_DECIMALS), body)

    async def submit_result(
        self,
        job_address: str,
        result: str,
        file: Optional[tuple[bytes, str]] = None,
    ) -> None:
        result_hash = await self._upload_result(result, file)
        body = build_job_message(
            "submit_result", result_hash=result_hash, result_type=RESULT_TYPE_PLAIN
        )
        await self._send(Address(job_address), to_nano("0.01", TON_DECIMALS), body)

    async def submit_encrypted_result(
        self,
        job_address: str,
        result: str,
        recipient_public_keys: Mapping[Role, bytes],
        file: Optional[tuple[bytes, str]] = None,
    ) -> None:
        """E2E-encrypt ``result`` for the client + evaluator, then submit.

        ``recipient_public_keys`` is a mapping with both ``"client"`` and
        ``"evaluator"`` ed25519 public keys (32 bytes each). Fetch them via
        :meth:`get_wallet_public_key`.
        """
        await self._ensure_wallet()
        assert self._wallet_secret_key is not None
        assert self._wallet_public_key is not None

        # Build result content (with file reference if attached)
        if file is not None and self._pinata.jwt:
            buffer, filename = file
            pinned = await self._pinata.pin_file(buffer, filename)
            import json as _json
            # Match JSON.stringify byte-for-byte (default escapes non-ASCII).
            result_content = _json.dumps(
                {
                    "result": result,
                    "file": {
                        "cid": pinned.cid,
                        "filename": pinned.filename,
                        "mimeType": pinned.mime_type,
                        "size": pinned.size,
                    },
                },
                separators=(",", ":"),
            )
        else:
            result_content = result

        envelope = encrypt_result(
            result_content,
            bytes(self._wallet_secret_key),
            bytes(self._wallet_public_key),
            recipient_public_keys,
        )
        envelope_dict = envelope.model_dump(by_alias=True)
        result_hash = await self._pinata.pin_json(envelope_dict)

        body = build_job_message(
            "submit_result",
            result_hash=result_hash,
            result_type=RESULT_TYPE_ENCRYPTED,
        )
        await self._send(Address(job_address), to_nano("0.01", TON_DECIMALS), body)

    async def decrypt_job_result(
        self, envelope: EncryptedEnvelope, role: Role
    ) -> str:
        """Decrypt an encrypted envelope using the configured wallet."""
        await self._ensure_wallet()
        assert self._wallet_secret_key is not None
        return _decrypt_envelope(envelope, role, bytes(self._wallet_secret_key))

    async def evaluate_job(
        self,
        job_address: str,
        approved: bool,
        reason: Optional[str] = None,
    ) -> None:
        if reason and self._pinata.jwt:
            reason_hash = await self._pinata.pin_json(
                {
                    "type": "evaluation_reason",
                    "reason": reason,
                    "evaluatedAt": datetime.now(timezone.utc).isoformat(),
                }
            )
        elif reason:
            reason_hash = reason_to_uint256(reason)
        else:
            reason_hash = 0
        body = build_job_message(
            "evaluate", approved=approved, reason_hash=reason_hash
        )
        await self._send(Address(job_address), to_nano("0.01", TON_DECIMALS), body)

    async def cancel_job(self, job_address: str) -> None:
        await self._send(
            Address(job_address),
            to_nano("0.01", TON_DECIMALS),
            build_job_message("cancel"),
        )

    async def claim_job(self, job_address: str) -> None:
        await self._send(
            Address(job_address),
            to_nano("0.01", TON_DECIMALS),
            build_job_message("claim"),
        )

    async def quit_job(self, job_address: str) -> None:
        await self._send(
            Address(job_address),
            to_nano("0.01", TON_DECIMALS),
            build_job_message("quit"),
        )

    async def set_budget(self, job_address: str, budget: str) -> None:
        budget_nano = to_nano(budget, TON_DECIMALS)
        body = build_job_message("set_budget", budget_nano=budget_nano)
        await self._send(Address(job_address), to_nano("0.01", TON_DECIMALS), body)

    # ───────────────────────────── writes (USDT) ─────────────────────────────

    async def create_jetton_job(self, params: CreateJobParams) -> str:
        """Create a USDT-budgeted job. Returns the new job contract address."""
        count_before = await self.get_jetton_job_count()
        desc_hash = await self._upload_description(params, include_file=False)
        budget_nano = to_nano(params.budget, USDT_DECIMALS)
        body = build_factory_message(
            evaluator=params.evaluator,
            budget_nano=budget_nano,
            description_hash=desc_hash,
            timeout=params.timeout,
            evaluation_timeout=params.eval_timeout,
        )
        await self._send(
            to=Address(self.jetton_factory_address),
            value_nano=to_nano("0.03", TON_DECIMALS),
            body=body,
        )
        count_after = await self._poll_for_count_increase(
            self.get_jetton_job_count, count_before
        )
        return await self.get_job_address(
            count_after - 1, self.jetton_factory_address
        )

    async def set_jetton_wallet(self, job_address: str) -> None:
        """Resolve the job's USDT wallet and install it on the jetton job."""
        stack = await self._client.run_get_method(
            self.usdt_master_address,
            "get_wallet_address",
            [Address(job_address)],
        )
        jetton_wallet = _require_address_obj(stack[0], "get_wallet_address")
        body = build_set_jetton_wallet_message(jetton_wallet)
        await self._send(Address(job_address), to_nano("0.01", TON_DECIMALS), body)

    async def fund_jetton_job(self, job_address: str) -> None:
        """Send a TEP-74 transfer from the sender's USDT wallet to the job."""
        wallet = await self._ensure_wallet()
        status = await self.get_job_status(job_address)

        sender_stack = await self._client.run_get_method(
            self.usdt_master_address,
            "get_wallet_address",
            [wallet.address],
        )
        sender_jetton_wallet = _require_address_obj(
            sender_stack[0], "get_wallet_address(sender)"
        )

        body = build_jetton_transfer_message(
            amount_nano=status.budget,
            destination=Address(job_address),
            response_destination=wallet.address,
            forward_ton_amount_nano=to_nano("0.05", TON_DECIMALS),
        )
        await self._send(
            to=sender_jetton_wallet,
            value_nano=to_nano("0.1", TON_DECIMALS),
            body=body,
        )

    # ───────────────────────────── helpers ─────────────────────────────

    async def _send(self, to: Address, value_nano: int, body: Cell) -> str:
        wallet = await self._ensure_wallet()
        initial_seqno = await wallet.get_seqno()
        message = wallet.create_wallet_internal_message(
            destination=to, value=value_nano, body=body
        )
        message_hash = await wallet.raw_transfer(messages=[message])
        await self._wait_for_seqno(wallet, initial_seqno)
        return message_hash

    async def _wait_for_seqno(
        self, wallet: WalletV5R1, initial_seqno: int
    ) -> None:
        """Poll the wallet's seqno until it increments, with backoff.

        Fast path (API key) expects inclusion within ~2s; slow path (public
        rate-limited toncenter) may take up to ~8s. We cap the total wait at
        ~12s before raising to match the NPM SDK's failure mode.
        """
        delays = [0.5, 0.5, 1.0, 1.0, 2.0, 2.0, 5.0]
        if not self._api_key:
            delays = [1.0, 1.0, 2.0, 2.0, 2.0, 4.0]
        for delay in delays:
            await asyncio.sleep(delay)
            try:
                current = await wallet.get_seqno()
            except Exception:
                continue
            if current > initial_seqno:
                return
        raise RuntimeError("Transaction not confirmed")

    async def _poll_for_count_increase(
        self,
        get_count: Any,
        count_before: int,
        max_wait: float = 12.0,
    ) -> int:
        """Wait until a factory's ``get_next_job_id`` crosses ``count_before``."""
        waited = 0.0
        delay = 1.0
        while waited < max_wait:
            after = await get_count()
            if after > count_before:
                return after
            await asyncio.sleep(delay)
            waited += delay
        raise RuntimeError("Job creation not confirmed on-chain")

    async def _upload_description(
        self,
        params: CreateJobParams,
        *,
        include_file: bool = True,
    ) -> int:
        """Upload job description (optionally with attached file) to IPFS."""
        created_at = datetime.now(timezone.utc).isoformat()
        if include_file and params.file is not None and self._pinata.jwt:
            buffer, filename = params.file
            pinned = await self._pinata.pin_file(buffer, filename)
            payload = {
                "type": "job_description",
                "description": params.description,
                "file": {
                    "cid": pinned.cid,
                    "filename": pinned.filename,
                    "mimeType": pinned.mime_type,
                    "size": pinned.size,
                },
                "createdAt": created_at,
            }
        else:
            payload = {
                "type": "job_description",
                "description": params.description,
                "createdAt": created_at,
            }
        return await self._pinata.pin_json(payload)

    async def _upload_result(
        self, result: str, file: Optional[tuple[bytes, str]]
    ) -> int:
        submitted_at = datetime.now(timezone.utc).isoformat()
        if file is not None and self._pinata.jwt:
            buffer, filename = file
            pinned = await self._pinata.pin_file(buffer, filename)
            payload = {
                "type": "job_result",
                "result": result,
                "file": {
                    "cid": pinned.cid,
                    "filename": pinned.filename,
                    "mimeType": pinned.mime_type,
                    "size": pinned.size,
                },
                "submittedAt": submitted_at,
            }
        else:
            payload = {
                "type": "job_result",
                "result": result,
                "submittedAt": submitted_at,
            }
        return await self._pinata.pin_json(payload)


# ─────────────────────── private utilities ──────────────────────────


def _require_address(value: Any, field: str) -> str:
    if not isinstance(value, Address):
        raise RuntimeError(f"Expected Address for {field}, got {type(value).__name__}")
    return value.to_str(is_bounceable=False)


def _require_address_obj(value: Any, where: str) -> Address:
    if not isinstance(value, Address):
        raise RuntimeError(f"Expected Address from {where}, got {type(value).__name__}")
    return value


__all__ = ["EnactClient"]
