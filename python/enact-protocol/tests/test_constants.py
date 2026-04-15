"""Lock constants against the TypeScript source.

Any divergence between Python and NPM SDKs here is a bug — both must produce
identical on-chain messages.
"""
from __future__ import annotations

from enact_protocol import (
    FACTORY_ADDRESS,
    JETTON_FACTORY_ADDRESS,
    USDT_MASTER_ADDRESS,
    FactoryOp,
    JobOp,
    JobState,
    STATE_NAMES,
)
from enact_protocol.constants import JETTON_TRANSFER_OP


def test_mainnet_addresses():
    # Verbatim from sdk/src/client.ts lines 7-9
    assert FACTORY_ADDRESS == "EQAFHodWCzrYJTbrbJp1lMDQLfypTHoJCd0UcerjsdxPECjX"
    assert JETTON_FACTORY_ADDRESS == "EQCgYmwi8uwrG7I6bI3Cdv0ct-bAB1jZ0DQ7C3dX3MYn6VTj"
    assert USDT_MASTER_ADDRESS == "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs"


def test_factory_opcodes():
    # sdk/src/client.ts:13 + sdk/src/wrappers/JobFactory.ts
    assert FactoryOp.CREATE_JOB == 0x00000010


def test_job_opcodes():
    # sdk/src/client.ts:14-18 + sdk/src/wrappers/Job.ts
    assert JobOp.FUND == 0x00000001
    assert JobOp.TAKE_JOB == 0x00000002
    assert JobOp.SUBMIT_RESULT == 0x00000003
    assert JobOp.EVALUATE == 0x00000004
    assert JobOp.CANCEL == 0x00000005
    assert JobOp.INIT_JOB == 0x00000006
    assert JobOp.CLAIM == 0x00000007
    assert JobOp.QUIT == 0x00000008
    assert JobOp.SET_BUDGET == 0x00000009
    assert JobOp.SET_JETTON_WALLET == 0x0000000A


def test_jetton_transfer_opcode():
    # TEP-74 standard jetton transfer, used in fund_jetton_job
    assert JETTON_TRANSFER_OP == 0x0F8A7EA5


def test_job_state_ordinals():
    # sdk/src/client.ts:11
    assert JobState.OPEN == 0
    assert JobState.FUNDED == 1
    assert JobState.SUBMITTED == 2
    assert JobState.COMPLETED == 3
    assert JobState.DISPUTED == 4
    assert JobState.CANCELLED == 5


def test_state_names():
    assert STATE_NAMES == (
        "OPEN",
        "FUNDED",
        "SUBMITTED",
        "COMPLETED",
        "DISPUTED",
        "CANCELLED",
    )
