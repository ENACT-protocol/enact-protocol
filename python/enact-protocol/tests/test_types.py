"""Pydantic model tests."""
from __future__ import annotations

from enact_protocol import CreateJobParams, JobData, JobListItem
from enact_protocol.types import EncryptedEnvelope, EncryptedRecipient


def test_job_list_item():
    item = JobListItem(job_id=0, address="EQ...", type="ton")
    assert item.job_id == 0
    assert item.type == "ton"


def test_create_job_params_defaults():
    p = CreateJobParams(
        description="x",
        budget="0.1",
        evaluator="UQ...",
    )
    assert p.timeout == 86400
    assert p.eval_timeout is None


def test_job_data_from_fields():
    data = JobData.from_fields(
        job_id=7,
        state=1,
        address="EQ_AAA",
        client_addr="UQ_CLIENT",
        provider_addr=None,
        evaluator_addr="UQ_EVAL",
        budget=123_456_789,
        desc_hash_int=0xABCD,
        result_hash_int=0,
        reason_hash_int=0,
        timeout=86400,
        created_at=1700000000,
        eval_timeout=86400,
        submitted_at=0,
    )
    assert data.state_name == "FUNDED"
    assert data.budget_ton == "0.1235"
    assert data.desc_hash.startswith("0000")
    assert len(data.desc_hash) == 64


def test_job_data_unknown_state():
    data = JobData.from_fields(
        job_id=0,
        state=99,
        address="EQ",
        client_addr="UQ_C",
        provider_addr=None,
        evaluator_addr="UQ_E",
        budget=0,
        desc_hash_int=0,
        result_hash_int=0,
        reason_hash_int=0,
        timeout=0,
        created_at=0,
        eval_timeout=0,
        submitted_at=0,
    )
    assert data.state_name == "UNKNOWN(99)"


def test_encrypted_envelope_roundtrip_json():
    env = EncryptedEnvelope(
        type="job_result_encrypted",
        version=1,
        sender_public_key="ab" * 32,
        recipients=[
            EncryptedRecipient(role="client", encrypted_key="aa", nonce="bb"),
            EncryptedRecipient(role="evaluator", encrypted_key="cc", nonce="dd"),
        ],
        ciphertext="Zm9v",
        nonce="YmFy",
        submitted_at="2026-04-15T00:00:00+00:00",
    )
    wire = env.model_dump(by_alias=True)
    assert wire["senderPublicKey"] == "ab" * 32
    assert wire["recipients"][0]["encryptedKey"] == "aa"
    # Rehydrate from wire format
    env2 = EncryptedEnvelope.model_validate(wire)
    assert env2.sender_public_key == env.sender_public_key
    assert env2.recipients[0].encrypted_key == "aa"
