"""Fixtures for service tests. All people, items and credentials are fictional.

Envelopes here are structurally valid random bytes: the service can only check
structure, never decrypt (design section 3). Real cryptography is covered by
core-ts tests and the end-to-end script.
"""

from __future__ import annotations

import base64
import os
import sys
import uuid
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from coven_service.app import create_app  # noqa: E402
from coven_service.common import Clock  # noqa: E402


def raw_public_key() -> bytes:
    k = ec.generate_private_key(ec.SECP256R1())
    return k.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)


def fake_envelope(n: int = 33) -> bytes:
    return b"\x01" + raw_public_key() + os.urandom(12) + os.urandom(n + 16)


def fake_sym(n: int = 40) -> bytes:
    return b"\x02" + os.urandom(12) + os.urandom(n + 16)


def b64(b: bytes) -> str:
    return base64.b64encode(b).decode()


class FakeTime:
    def __init__(self, t: float = 1_800_000_000):
        self.t = t

    def __call__(self) -> float:
        return self.t


@pytest.fixture
def env(tmp_path):
    t = FakeTime()
    app = create_app(str(tmp_path / "test.sqlite"), clock=Clock(base=t))
    clients: dict[str, TestClient] = {}

    def as_(user: str) -> TestClient:
        if user not in clients:
            c = TestClient(app)
            r = c.post("/api/session", json={"user": user})
            assert r.status_code == 200, r.text
            clients[user] = c
        return clients[user]

    return {"app": app, "as": as_, "time": t}


APPROVERS = ["user:sage", "user:rowan", "user:ash", "user:wren"]


def seal(env, item_id: str = "aws-root", threshold: int = 2, approvers=APPROVERS) -> str:
    quinn = env["as"]("user:quinn")
    if quinn.get("/api/bg/items").json() == [] or item_id not in [i["item_id"] for i in quinn.get("/api/bg/items").json()]:
        r = quinn.post("/api/bg/items", json={"item_id": item_id, "name": f"{item_id} (fictional)"})
        assert r.status_code == 200, r.text
    for a in approvers:
        env["as"](a).post("/api/enroll", json={"public_key": b64(raw_public_key())})
    vid = str(uuid.uuid4())
    r = quinn.post(
        f"/api/bg/items/{item_id}/seal-versions",
        json={
            "seal_version_id": vid,
            "threshold": threshold,
            "approver_ids": approvers,
            "header": b64(fake_sym()),
            "ciphertext": b64(fake_sym()),
            "approver_shares": {a: b64(fake_envelope()) for a in approvers},
        },
    )
    assert r.status_code == 200, r.text
    return vid


def open_petition(env, requester: str = "user:robin", item_id: str = "aws-root", window: int = 900) -> dict:
    r = env["as"](requester).post(
        "/api/bg/petitions",
        json={"item_id": item_id, "reason": "prod database locked out (fictional)", "requested_window_seconds": window,
              "requester_public_key": b64(raw_public_key())},
    )
    assert r.status_code == 200, r.text
    return r.json()


def approve(env, approver: str, pid: str):
    return env["as"](approver).post(f"/api/bg/petitions/{pid}/approvals", json={"envelope": b64(fake_envelope())})


RELEASE_FIELDS = {"item_ciphertext", "item_header", "envelopes", "ciphertext", "header", "approver_share", "envelope"}


def has_release_material(body) -> bool:
    if isinstance(body, dict):
        return any(k in RELEASE_FIELDS for k in body) or any(has_release_material(v) for v in body.values())
    if isinstance(body, list):
        return any(has_release_material(v) for v in body)
    return False
