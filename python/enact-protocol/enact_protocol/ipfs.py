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
from typing import Any

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


__all__ = [
    "PinataClient",
    "PinnedFile",
    "compute_uint256_hash",
    "mime_for_filename",
]
