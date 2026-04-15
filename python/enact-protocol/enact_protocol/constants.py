"""On-chain constants for ENACT Protocol.

Mirrors the values hardcoded in ``sdk/src/client.ts`` and ``contracts/job.tolk``.
Tests in ``tests/test_constants.py`` lock these against the TypeScript source.
"""
from __future__ import annotations

from enum import IntEnum
from typing import Final

FACTORY_ADDRESS: Final[str] = "EQAFHodWCzrYJTbrbJp1lMDQLfypTHoJCd0UcerjsdxPECjX"
JETTON_FACTORY_ADDRESS: Final[str] = "EQCgYmwi8uwrG7I6bI3Cdv0ct-bAB1jZ0DQ7C3dX3MYn6VTj"
USDT_MASTER_ADDRESS: Final[str] = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs"

DEFAULT_TONCENTER_ENDPOINT: Final[str] = "https://toncenter.com/api/v2/jsonRPC"
DEFAULT_TIMEOUT_SECONDS: Final[int] = 86400

TON_DECIMALS: Final[int] = 9
USDT_DECIMALS: Final[int] = 6


class JobState(IntEnum):
    OPEN = 0
    FUNDED = 1
    SUBMITTED = 2
    COMPLETED = 3
    DISPUTED = 4
    CANCELLED = 5


STATE_NAMES: Final[tuple[str, ...]] = tuple(s.name for s in JobState)


class FactoryOp(IntEnum):
    CREATE_JOB = 0x00000010


class JobOp(IntEnum):
    FUND = 0x00000001
    TAKE_JOB = 0x00000002
    SUBMIT_RESULT = 0x00000003
    EVALUATE = 0x00000004
    CANCEL = 0x00000005
    INIT_JOB = 0x00000006
    CLAIM = 0x00000007
    QUIT = 0x00000008
    SET_BUDGET = 0x00000009
    SET_JETTON_WALLET = 0x0000000A


JETTON_TRANSFER_OP: Final[int] = 0x0F8A7EA5

RESULT_TYPE_PLAIN: Final[int] = 0
RESULT_TYPE_ENCRYPTED: Final[int] = 1
