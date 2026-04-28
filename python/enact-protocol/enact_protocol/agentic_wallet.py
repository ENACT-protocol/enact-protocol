"""Agentic Wallet provider — Python port of ``sdk/src/providers/AgenticWalletProvider.ts``.

The TON Tech Agentic Wallet is a modified ``wallet v5`` deployed as an SBT in
the agents.ton.org NFT collection. It has a split-key design:

* **owner** controls the SBT and can revoke / rotate the operator on-chain;
* **operator** (this provider) signs every outgoing transaction.

ENACT routes all writes through the operator path when an
:class:`AgenticWalletProvider` is passed to :class:`enact_protocol.EnactClient`.

Contract reference:
    https://github.com/the-ton-tech/agentic-wallet-contract
    contracts/messages.tolk -> ExternalSignedRequest (opcode 0xbf235204)

The body layout matches the TS provider exactly::

    opcode (32) || walletNftIndex (256) || validUntil (32) || seqno (32)
    || Maybe(^OutActionsCell) || Maybe(^extraActions)
    || signature (512, appended after hashing)
"""
from __future__ import annotations

import secrets
import time
from dataclasses import dataclass
from typing import Optional, TYPE_CHECKING
from urllib.parse import urlencode

from nacl.bindings import crypto_sign_seed_keypair
from nacl.signing import SigningKey
from pytoniq_core import Address, Cell, begin_cell

if TYPE_CHECKING:
    from tonutils.client import ToncenterV2Client


EXTERNAL_SIGNED_REQUEST_OPCODE = 0xBF235204
"""Opcode parsed by the contract's ``onExternalMessage``."""

INTERNAL_SIGNED_REQUEST_OPCODE = 0x4A3CA895
"""Opcode parsed by ``onInternalMessage`` for owner-driven sends."""

WALLET_V5_OUTACTION_SEND_MSG = 0x0EC3C86D
"""Action tag from wallet v5 spec: ``action_send_msg#0ec3c86d``."""


@dataclass
class AgenticWalletInfo:
    """Result of :func:`detect_agentic_wallet`. Mirrors the TS interface."""

    is_agentic_wallet: bool
    owner_address: Optional[str] = None
    operator_public_key: Optional[bytes] = None
    origin_operator_public_key: Optional[bytes] = None
    collection_address: Optional[str] = None
    nft_item_index: Optional[int] = None
    revoked_at: Optional[int] = None
    is_revoked: bool = False


def _build_out_actions_cell(messages: list[tuple[int, Cell]]) -> Cell:
    """Build a wallet v5 OutAction list cell (linked-list of action_send_msg).

    ``messages`` is a list of ``(send_mode, internal_message_cell)`` pairs. The
    internal message cell must already be a serialized MessageRelaxed (i.e.
    bit-0 cleared, src omitted, etc.) — exactly what
    :func:`_build_internal_message_cell` returns.

    Layout per cell::

        prev_action_cell^? (or empty for first)
        action_send_msg#0ec3c86d mode:(## 8) out_msg:^MessageRelaxed
    """
    next_cell: Optional[Cell] = None
    # Wallet v5 stores the action list as a forward-linked structure where
    # each cell holds (^prev, tag, mode, ^msg). Iterating in reverse makes the
    # head cell the last-built one.
    for mode, msg in messages:
        b = begin_cell()
        if next_cell is not None:
            b.store_ref(next_cell)
        else:
            # Empty prev-cell ref (placeholder used by storeOutList for the
            # tail of the chain). storeOutList in @ton/core writes a single
            # empty ref here — match its behaviour.
            b.store_ref(begin_cell().end_cell())
        b.store_uint(WALLET_V5_OUTACTION_SEND_MSG, 32)
        b.store_uint(mode, 8)
        b.store_ref(msg)
        next_cell = b.end_cell()
    assert next_cell is not None, "buildOutActionsCell needs at least one message"
    return next_cell


_CELL_MAX_BITS = 1023
_CELL_MAX_REFS = 4


def _build_internal_message_cell(
    *,
    to: Address,
    value_nano: int,
    body: Cell,
    bounce: bool = True,
) -> Cell:
    """Serialize a MessageRelaxed.

    Mirrors ``@ton/core``'s ``storeMessageRelaxed`` exactly: body is inlined
    (Either left = 0, no ref) when its bits + refs fit in the remaining cell
    budget; otherwise wrapped as ``^Cell`` (Either right = 1).
    """
    info = begin_cell()
    info.store_uint(0, 1)        # int_msg_info$0
    info.store_uint(1, 1)        # ihr_disabled = true
    info.store_bit(bounce)
    info.store_uint(0, 1)        # bounced = false
    info.store_address(None)     # src = addr_none
    info.store_address(to)
    info.store_coins(value_nano)
    info.store_uint(0, 1)        # extra_currencies (Maybe) = nothing
    info.store_coins(0)          # ihr_fee
    info.store_coins(0)          # fwd_fee
    info.store_uint(0, 64)       # created_lt
    info.store_uint(0, 32)       # created_at
    info.store_uint(0, 1)        # init (Maybe StateInit) = nothing

    # Tally what's already written so we know whether we can inline body.
    used_bits = len(info.bits)
    used_refs = len(info.refs)
    body_bits = len(body.bits)
    body_refs = len(body.refs)
    can_inline = (
        used_bits + 1 + body_bits <= _CELL_MAX_BITS
        and used_refs + body_refs <= _CELL_MAX_REFS
    )
    if can_inline:
        info.store_uint(0, 1)  # body = left (inline)
        # Append body bits + body refs into the parent cell.
        info.store_bits(body.bits)
        for ref in body.refs:
            info.store_ref(ref)
    else:
        info.store_uint(1, 1)  # body = right (^Cell)
        info.store_ref(body)
    return info.end_cell()


class AgenticWalletProvider:
    """Alternative signer for :class:`enact_protocol.EnactClient` writes.

    Pass to ``EnactClient(agentic_wallet=...)`` and every transaction is signed
    through ``ExternalSignedRequest`` instead of the mnemonic wallet v5 path.

    Args:
        operator_secret_key: 64-byte ed25519 secret key (seed||pub) — same
            format produced by ``nacl.signing.SigningKey().encode() + verify``.
        agentic_wallet_address: Deployed Agentic Wallet contract address.
        client: Active :class:`tonutils.client.ToncenterV2Client` used to
            fetch ``seqno`` / ``get_subwallet_id`` and broadcast externals.
        wallet_nft_index: Optional pre-known NFT index (uint256). If absent,
            fetched once via ``get_subwallet_id`` and cached.
        validity_seconds: Default ``validUntil`` window for signed requests
            (default 60s). Replays beyond the window are rejected on-chain.
    """

    def __init__(
        self,
        *,
        operator_secret_key: bytes,
        agentic_wallet_address: str | Address,
        client: "ToncenterV2Client",
        wallet_nft_index: Optional[int] = None,
        validity_seconds: int = 60,
    ) -> None:
        if len(operator_secret_key) != 64:
            raise ValueError(
                "operator_secret_key must be 64 bytes (ed25519 seed||pub)"
            )
        self._operator_secret_key = bytes(operator_secret_key)
        # SigningKey works on the 32-byte seed prefix, matching @ton/crypto.
        self._signing_key = SigningKey(self._operator_secret_key[:32])
        self.address = (
            agentic_wallet_address
            if isinstance(agentic_wallet_address, Address)
            else Address(agentic_wallet_address)
        )
        self._client = client
        self._validity_seconds = validity_seconds
        self._cached_nft_index: Optional[int] = wallet_nft_index

    def get_address(self) -> Address:
        """Return the agentic wallet address (used as the ``from`` of every ENACT op)."""
        return self.address

    async def fetch_seqno(self) -> int:
        stack = await self._client.run_get_method(self.address.to_str(), "seqno", [])
        return int(stack[0])

    async def fetch_wallet_nft_index(self) -> int:
        if self._cached_nft_index is not None:
            return self._cached_nft_index
        stack = await self._client.run_get_method(
            self.address.to_str(), "get_subwallet_id", []
        )
        self._cached_nft_index = int(stack[0])
        return self._cached_nft_index

    def _build_signed_body(
        self,
        *,
        nft_index: int,
        valid_until: int,
        seqno: int,
        out_actions: Optional[Cell],
    ) -> Cell:
        b = begin_cell()
        b.store_uint(EXTERNAL_SIGNED_REQUEST_OPCODE, 32)
        b.store_uint(nft_index, 256)
        b.store_uint(valid_until, 32)
        b.store_uint(seqno, 32)
        if out_actions is not None:
            b.store_uint(1, 1)
            b.store_ref(out_actions)
        else:
            b.store_uint(0, 1)
        b.store_uint(0, 1)  # Maybe(^extraActions) = nothing
        return b.end_cell()

    async def send_transaction(
        self,
        *,
        to: Address,
        value_nano: int,
        body: Cell,
        bounce: bool = True,
        # PAY_GAS_SEPARATELY (1) | IGNORE_ERRORS (2) = 3.
        # The agentic-wallet contract requires IGNORE_ERRORS on every
        # external-driven send (c5-register-validation.tolk:
        # ERROR_EXTERNAL_SEND_MESSAGE_MUST_HAVE_IGNORE_ERRORS_SEND_MODE).
        # Without it the action phase aborts after seqno is committed —
        # the wallet looks like it processed the external (seqno bumps)
        # but emits zero internal messages.
        send_mode: int = 3,
    ) -> str:
        """Sign + broadcast a single internal transfer through the agentic wallet.

        Returns the BoC hex of the external message that was broadcast.
        """
        seqno = await self.fetch_seqno()
        nft_index = await self.fetch_wallet_nft_index()
        valid_until = int(time.time()) + self._validity_seconds

        internal_msg = _build_internal_message_cell(
            to=to, value_nano=value_nano, body=body, bounce=bounce
        )
        out_actions = _build_out_actions_cell([(send_mode, internal_msg)])

        signed_body = self._build_signed_body(
            nft_index=nft_index,
            valid_until=valid_until,
            seqno=seqno,
            out_actions=out_actions,
        )

        signature = self._signing_key.sign(signed_body.hash).signature

        # Append signature: rebuild the cell exactly, then append 512 bits.
        final_body = (
            begin_cell()
            .store_cell(signed_body)
            .store_bytes(signature)
            .end_cell()
        )

        # Wrap as an external-in message: (10 src=addr_none, dest, import_fee=0,
        # init=nothing, body=^Cell)
        ext = begin_cell()
        ext.store_uint(0b10, 2)        # ext_in_msg_info$10
        ext.store_uint(0, 2)           # src = addr_none
        ext.store_address(self.address)
        ext.store_coins(0)             # import_fee
        ext.store_uint(0, 1)           # init = nothing
        ext.store_uint(1, 1)           # body in ^Cell
        ext.store_ref(final_body)
        boc = ext.end_cell().to_boc()
        # ToncenterV2Client.send_message accepts hex strings or bytes; pass
        # the hex form for compatibility with its annotated signature.
        boc_hex = boc.hex()
        await self._client.send_message(boc_hex)

        # Wait for seqno to bump so callers reading post-tx state see it.
        # Mirrors the v5 mnemonic path. Polls every 1s up to 12s.
        import asyncio
        for delay in (1.0, 1.0, 1.0, 1.0, 1.5, 1.5, 2.0, 3.0):
            await asyncio.sleep(delay)
            try:
                current = await self.fetch_seqno()
                if current > seqno:
                    return boc_hex
            except Exception:
                continue
        raise RuntimeError(
            f"Agentic wallet transaction not confirmed: seqno did not bump from {seqno}"
        )


async def detect_agentic_wallet(
    client: "ToncenterV2Client", address: str | Address
) -> AgenticWalletInfo:
    """Probe an address for the standard agentic wallet get-methods.

    Mirrors :func:`detectAgenticWallet` from the TS SDK. Returns
    ``AgenticWalletInfo(is_agentic_wallet=False)`` on any failure — callers
    should treat that as "render as a regular wallet".
    """
    addr_str = address.to_str() if isinstance(address, Address) else address
    try:
        pk_stack = await client.run_get_method(addr_str, "get_public_key", [])
        origin_stack = await client.run_get_method(addr_str, "get_origin_public_key", [])
        nft_stack = await client.run_get_method(addr_str, "get_nft_data", [])
        auth_stack = await client.run_get_method(addr_str, "get_authority_address", [])
        revoked_stack = await client.run_get_method(addr_str, "get_revoked_time", [])
    except Exception:
        return AgenticWalletInfo(is_agentic_wallet=False)

    try:
        operator_pub_int = int(pk_stack[0])
        origin_pub_int = int(origin_stack[0])
        # get_nft_data returns: init, index, collection_addr, owner_addr, content
        nft_index = int(nft_stack[1])
        collection_from_nft = nft_stack[2]
        owner_addr = nft_stack[3]
        # get_authority_address may return addr_none (None) on SBTs whose
        # authority is the collection itself — fall back in that case.
        auth_addr = auth_stack[0] if auth_stack else None
        collection_addr = (
            auth_addr if isinstance(auth_addr, Address) else collection_from_nft
        )
        revoked_at = int(revoked_stack[0])

        if not isinstance(owner_addr, Address):
            return AgenticWalletInfo(is_agentic_wallet=False)

        return AgenticWalletInfo(
            is_agentic_wallet=True,
            owner_address=owner_addr.to_str(is_bounceable=False),
            operator_public_key=operator_pub_int.to_bytes(32, "big"),
            origin_operator_public_key=origin_pub_int.to_bytes(32, "big"),
            collection_address=(
                collection_addr.to_str()
                if isinstance(collection_addr, Address)
                else None
            ),
            nft_item_index=nft_index,
            revoked_at=revoked_at,
            is_revoked=operator_pub_int == 0,
        )
    except Exception:
        return AgenticWalletInfo(is_agentic_wallet=False)


def generate_agent_keypair(
    agent_name: Optional[str] = None,
) -> dict[str, str]:
    """Generate an ed25519 keypair for use as Agentic Wallet operator.

    Returns a dict with ``public_key_hex``, ``secret_key_hex`` (64-byte
    seed||pub form expected by :class:`AgenticWalletProvider`), and
    ``create_deeplink`` to ``agents.ton.org/create`` for minting a wallet on
    top of this operator key.
    """
    seed = secrets.token_bytes(32)
    pub, sec = crypto_sign_seed_keypair(seed)
    params = {"operatorPublicKey": pub.hex()}
    if agent_name:
        params["name"] = agent_name
    return {
        "public_key_hex": pub.hex(),
        "secret_key_hex": sec.hex(),
        "create_deeplink": "https://agents.ton.org/create?" + urlencode(params),
    }


__all__ = [
    "EXTERNAL_SIGNED_REQUEST_OPCODE",
    "INTERNAL_SIGNED_REQUEST_OPCODE",
    "AgenticWalletProvider",
    "AgenticWalletInfo",
    "detect_agentic_wallet",
    "generate_agent_keypair",
]
