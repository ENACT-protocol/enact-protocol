"""Pinata (IPFS) client.

Port of the ``_uploadToIPFS`` / ``_uploadFileToIPFS`` helpers from
``sdk/src/client.ts``. The on-chain hash is the SHA-256 of the JSON payload
(for JSON uploads) or the raw file bytes (for file uploads), stored as a
256-bit uint.

When no Pinata JWT is provided, ``pin_json`` mirrors the NPM SDK: it still
computes the hash but skips the network request, so callers can run read-only
or hash-only flows without pinning.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Optional

import httpx

PINATA_JSON_ENDPOINT = "https://api.pinata.cloud/pinning/pinJSONToIPFS"
PINATA_FILE_ENDPOINT = "https://api.pinata.cloud/pinning/pinFileToIPFS"

_MIME_BY_EXT: dict[str, str] = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "pdf": "application/pdf",
    "txt": "text/plain",
    "zip": "application/zip",
    "json": "application/json",
    "md": "text/markdown",
}


def mime_for_filename(filename: str) -> str:
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    return _MIME_BY_EXT.get(ext, "application/octet-stream")


def compute_uint256_hash(content: Any) -> int:
    """SHA-256 of a JSON-serialisable object, returned as a uint256 int.

    The serialisation must match ``JSON.stringify(content)`` from the NPM SDK
    byte-for-byte, so that a description uploaded from Python produces the
    same on-chain ``descHash`` as one uploaded from JS. ``JSON.stringify``
    escapes non-ASCII characters to ``\\uXXXX`` by default — so we set
    ``ensure_ascii=True`` (Python's default) and use the same compact
    separators the JS SDK implicitly produces.
    """
    if isinstance(content, bytes):
        data = content
    elif isinstance(content, str):
        data = content.encode("utf-8")
    else:
        data = json.dumps(content, separators=(",", ":")).encode("utf-8")
    return int.from_bytes(hashlib.sha256(data).digest(), "big")


@dataclass
class PinnedFile:
    hash: int
    cid: str
    filename: str
    mime_type: str
    size: int


class PinataClient:
    """Minimal async Pinata client. Uses ``httpx.AsyncClient``.

    Call ``await close()`` or use as an async context manager to release
    connections. A ``None`` JWT disables network uploads (hashes are still
    computed) — useful for CI and for offline testing.
    """

    def __init__(
        self,
        jwt: str | None,
        *,
        timeout: float = 30.0,
        http: httpx.AsyncClient | None = None,
    ) -> None:
        self.jwt = jwt
        self._owns_http = http is None
        self._http = http or httpx.AsyncClient(timeout=timeout)

    async def __aenter__(self) -> "PinataClient":
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.close()

    async def close(self) -> None:
        if self._owns_http:
            await self._http.aclose()

    async def pin_json(self, content: Any) -> int:
        """Upload a JSON-compatible object. Returns the on-chain uint256 hash.

        If ``self.jwt`` is ``None``, skips the upload (mirrors NPM SDK).
        """
        json_str = json.dumps(content, separators=(",", ":"))
        hash_int = compute_uint256_hash(json_str)

        if not self.jwt:
            return hash_int

        short = f"{hash_int:064x}"[:8]
        body = {
            "pinataContent": content,
            "pinataMetadata": {
                "name": f"enact-{short}",
                "keyvalues": {"descHash": f"{hash_int:064x}"},
            },
        }
        resp = await self._http.post(
            PINATA_JSON_ENDPOINT,
            json=body,
            headers={
                "Authorization": f"Bearer {self.jwt}",
                "Content-Type": "application/json",
            },
        )
        if resp.status_code >= 400:
            raise RuntimeError(f"IPFS upload failed: {resp.status_code} {resp.text}")
        return hash_int

    async def pin_file(self, buffer: bytes, filename: str) -> PinnedFile:
        """Upload a binary file to Pinata. Requires a JWT."""
        if not self.jwt:
            raise RuntimeError("pinata_jwt required for file uploads")
        hash_int = compute_uint256_hash(buffer)
        mime_type = mime_for_filename(filename)
        short = f"{hash_int:064x}"[:8]
        metadata = {
            "name": f"enact-file-{short}",
            "keyvalues": {
                "descHash": f"{hash_int:064x}",
                "type": "file",
                "filename": filename,
                "mimeType": mime_type,
                "size": str(len(buffer)),
            },
        }
        files = {
            "file": (filename, buffer, mime_type),
            "pinataMetadata": (None, json.dumps(metadata), "application/json"),
        }
        resp = await self._http.post(
            PINATA_FILE_ENDPOINT,
            files=files,
            headers={"Authorization": f"Bearer {self.jwt}"},
        )
        if resp.status_code >= 400:
            raise RuntimeError(
                f"File upload failed: {resp.status_code} {resp.text}"
            )
        data = resp.json()
        cid = data.get("IpfsHash")
        if not isinstance(cid, str):
            raise RuntimeError(f"Unexpected Pinata response: {data}")
        return PinnedFile(
            hash=hash_int,
            cid=cid,
            filename=filename,
            mime_type=mime_type,
            size=len(buffer),
        )


# ─── Lighthouse + provider-agnostic IPFS ──────────────────────────────

LIGHTHOUSE_UPLOAD_ENDPOINT = "https://upload.lighthouse.storage/api/v0/add?cid-version=1"


IpfsUploader = Callable[[bytes, str, str], Awaitable["UploadResult"]]
"""Callback signature for plugging in any IPFS provider.

Takes ``(buffer, filename, mime_type)`` and returns an :class:`UploadResult`
with at least the CID. The on-chain hash stays SHA-256 of the JSON payload
(computed by the SDK), so contract storage is unchanged across providers.

Use this to integrate Web3.Storage, NFT.Storage, Filebase, your own
backend, etc.::

    async def my_uploader(buffer, filename, mime):
        cid = await my_w3up_client.upload_file(buffer)
        return UploadResult(cid=str(cid))
    EnactClient(ipfs_uploader=my_uploader, ...)
"""


@dataclass
class UploadResult:
    cid: str
    gateway_url: Optional[str] = None


class LighthouseClient:
    """Minimal async Lighthouse.storage uploader."""

    def __init__(
        self,
        api_key: str,
        *,
        timeout: float = 45.0,
        http: httpx.AsyncClient | None = None,
    ) -> None:
        self.api_key = api_key
        self._owns_http = http is None
        self._http = http or httpx.AsyncClient(timeout=timeout)

    async def close(self) -> None:
        if self._owns_http:
            await self._http.aclose()

    async def upload(self, buffer: bytes, filename: str, mime_type: str) -> str:
        files = {"file": (filename, buffer, mime_type)}
        resp = await self._http.post(
            LIGHTHOUSE_UPLOAD_ENDPOINT,
            files=files,
            headers={"Authorization": f"Bearer {self.api_key}"},
        )
        if resp.status_code >= 400:
            raise RuntimeError(
                f"Lighthouse upload failed: {resp.status_code} {resp.text[:120]}"
            )
        data = resp.json()
        cid = data.get("Hash")
        if not isinstance(cid, str):
            raise RuntimeError(f"Unexpected Lighthouse response: {data}")
        return cid


class IPFSClient:
    """Provider-agnostic IPFS pinner used internally by EnactClient.

    Priority order on every upload:

        1. ``ipfs_uploader`` callback (if supplied)
        2. ``LighthouseClient`` (if API key supplied)
        3. ``PinataClient`` (if JWT supplied)

    When none are configured, ``pin_json`` mirrors the NPM SDK: it computes
    the SHA-256 hash but skips the network — the on-chain hash stays valid
    even though no IPFS pin exists, so callers running read-only or
    hash-only flows still work.
    """

    def __init__(
        self,
        *,
        lighthouse_api_key: Optional[str] = None,
        pinata_jwt: Optional[str] = None,
        ipfs_uploader: Optional[IpfsUploader] = None,
        timeout: float = 30.0,
    ) -> None:
        self._http = httpx.AsyncClient(timeout=timeout)
        self.lighthouse = LighthouseClient(lighthouse_api_key, http=self._http) if lighthouse_api_key else None
        self.pinata = PinataClient(pinata_jwt, http=self._http) if pinata_jwt else PinataClient(None, http=self._http)
        self.ipfs_uploader = ipfs_uploader

    @property
    def jwt(self) -> Optional[str]:
        # Backward-compat shim: client.py guards `if self._pinata.jwt:` to
        # decide whether IPFS uploads are configured. Treat any configured
        # provider as "uploads available".
        if self.ipfs_uploader is not None:
            return "uploader"
        if self.lighthouse is not None:
            return "lighthouse"
        return self.pinata.jwt

    async def close(self) -> None:
        await self._http.aclose()

    async def pin_json(self, content: Any) -> int:
        json_str = json.dumps(content, separators=(",", ":"))
        hash_int = compute_uint256_hash(json_str)
        if self.ipfs_uploader is None and self.lighthouse is None and not self.pinata.jwt:
            # No provider configured — return the hash without uploading,
            # mirroring the NPM SDK behavior.
            return hash_int
        short = f"{hash_int:064x}"[:8]
        filename = f"enact-{short}.json"
        buffer = json_str.encode("utf-8")
        try:
            if self.ipfs_uploader is not None:
                await self.ipfs_uploader(buffer, filename, "application/json")
                return hash_int
            if self.lighthouse is not None:
                try:
                    await self.lighthouse.upload(buffer, filename, "application/json")
                    return hash_int
                except Exception:
                    if not self.pinata.jwt:
                        raise
            # Fallback: Pinata (legacy)
            return await self.pinata.pin_json(content)
        except Exception:
            raise

    async def pin_file(self, buffer: bytes, filename: str) -> PinnedFile:
        hash_int = compute_uint256_hash(buffer)
        mime_type = mime_for_filename(filename)
        short = f"{hash_int:064x}"[:8]
        tagged = filename if filename.startswith("enact-") else f"enact-file-{short}-{filename}"
        if self.ipfs_uploader is not None:
            r = await self.ipfs_uploader(buffer, tagged, mime_type)
            return PinnedFile(hash=hash_int, cid=r.cid, filename=filename, mime_type=mime_type, size=len(buffer))
        if self.lighthouse is not None:
            try:
                cid = await self.lighthouse.upload(buffer, tagged, mime_type)
                return PinnedFile(hash=hash_int, cid=cid, filename=filename, mime_type=mime_type, size=len(buffer))
            except Exception:
                if not self.pinata.jwt:
                    raise
        # Fallback: Pinata
        return await self.pinata.pin_file(buffer, filename)


__all__ = [
    "PinataClient",
    "PinnedFile",
    "compute_uint256_hash",
    "mime_for_filename",
    "IpfsUploader",
    "UploadResult",
    "LighthouseClient",
    "IPFSClient",
]
