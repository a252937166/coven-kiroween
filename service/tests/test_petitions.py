"""Spec 05 checks T-02 to T-11, T-14, T-15 against the HTTP API. Fictional data."""

from __future__ import annotations

import base64
import logging
import sqlite3
import threading

import pytest

from conftest import (
    APPROVERS,
    approve,
    b64,
    fake_envelope,
    has_release_material,
    open_petition,
    raw_public_key,
    seal,
)


def test_t03_release_after_quorum_returns_complete_package(env):
    seal(env)
    p = open_petition(env)
    pid = p["petition_id"]
    robin = env["as"]("user:robin")
    assert robin.get(f"/api/bg/petitions/{pid}/release").status_code == 409
    approve(env, "user:sage", pid)
    assert robin.get(f"/api/bg/petitions/{pid}/release").status_code == 409
    r = approve(env, "user:rowan", pid)
    assert r.json()["status"]["state"] == "Approved"
    rel = robin.get(f"/api/bg/petitions/{pid}/release")
    assert rel.status_code == 200
    body = rel.json()
    assert len(body["envelopes"]) == 2
    assert {e["approver_id"] for e in body["envelopes"]} == {"user:sage", "user:rowan"}
    assert body["item_ciphertext"] and body["item_header"]
    assert rel.headers["cache-control"] == "no-store"
    # Decision D5: repeat retrieval allowed until expiry.
    assert robin.get(f"/api/bg/petitions/{pid}/release").status_code == 200


def test_t01_t02_no_material_before_quorum_on_any_requester_path(env):
    seal(env)
    pid = open_petition(env)["petition_id"]
    approve(env, "user:sage", pid)
    robin = env["as"]("user:robin")
    for path in (f"/api/bg/petitions/{pid}", "/api/bg/petitions", f"/api/bg/petitions/{pid}/release",
                 f"/api/bg/petitions/{pid}/approver-share", "/api/bg/items"):
        r = robin.get(path)
        assert not has_release_material(r.json()), path
    assert robin.get(f"/api/bg/petitions/{pid}/approver-share").status_code == 404


def test_t02_route_inventory(env):
    """Only /release returns release material; /approver-share returns only the caller's blob."""
    app = env["app"]
    gets = sorted(r.path for r in app.routes if "GET" in getattr(r, "methods", set()) and r.path.startswith("/api/bg"))
    assert gets == [
        "/api/bg/items",
        "/api/bg/petitions",
        "/api/bg/petitions/{pid}",
        "/api/bg/petitions/{pid}/approver-share",
        "/api/bg/petitions/{pid}/release",
    ]
    seal(env)
    pid = open_petition(env)["petition_id"]
    sage = env["as"]("user:sage").get(f"/api/bg/petitions/{pid}/approver-share").json()
    assert set(sage) == {"status", "approver_share"}
    assert not has_release_material(sage["status"])
    rowan = env["as"]("user:rowan").get(f"/api/bg/petitions/{pid}/approver-share").json()
    assert sage["approver_share"] != rowan["approver_share"]


@pytest.mark.parametrize("closer", ["expire", "deny", "reseal"])
def test_t04_t05_closed_petitions_and_old_links_return_nothing(env, closer):
    seal(env)
    pid = open_petition(env)["petition_id"]
    approve(env, "user:sage", pid)
    approve(env, "user:rowan", pid)
    robin = env["as"]("user:robin")
    kit = env["as"]("user:kit")
    link = f"/api/bg/petitions/{pid}/release"
    assert robin.get(link).status_code == 200
    assert kit.get(link).status_code == 404
    if closer == "expire":
        env["time"].t += 900  # now == expires_at must reject
    elif closer == "deny":
        # Released petitions cannot be denied; deny a fresh one instead.
        pid2 = open_petition(env)["petition_id"]
        assert env["as"]("user:ash").post(f"/api/bg/petitions/{pid2}/deny").status_code == 200
        link = f"/api/bg/petitions/{pid2}/release"
        approve_after = approve(env, "user:sage", pid2)
        assert approve_after.status_code == 409
    else:
        seal(env)
    r = robin.get(link)
    assert r.status_code == 410
    assert not has_release_material(r.json())
    assert kit.get(link).status_code == 404
    state = robin.get(link.replace("/release", "")).json()["state"]
    assert state in ("Expired", "Denied", "Invalidated")
    # Terminal: still closed later, and approvals stay refused.
    env["time"].t += 10
    assert robin.get(link).status_code == 410
    assert robin.get(link.replace("/release", "")).json()["state"] == state


def test_t03_expiry_boundary(env):
    seal(env)
    pid = open_petition(env, window=120)["petition_id"]
    approve(env, "user:sage", pid)
    approve(env, "user:rowan", pid)
    robin = env["as"]("user:robin")
    env["time"].t += 119
    assert robin.get(f"/api/bg/petitions/{pid}/release").status_code == 200
    env["time"].t += 1
    assert robin.get(f"/api/bg/petitions/{pid}/release").status_code == 410


def test_t04_expired_open_petition_refuses_approvals(env):
    seal(env)
    pid = open_petition(env, window=60)["petition_id"]
    env["time"].t += 60
    r = approve(env, "user:sage", pid)
    assert r.status_code == 409
    assert env["as"]("user:robin").get(f"/api/bg/petitions/{pid}").json()["state"] == "Expired"


def test_t06_split_approvals_across_two_petitions(env):
    """BG-01.4: one approval on each of two petitions releases nothing."""
    seal(env)
    a = open_petition(env)["petition_id"]
    b = open_petition(env)["petition_id"]
    approve(env, "user:sage", a)
    approve(env, "user:rowan", b)
    again = approve(env, "user:sage", a)
    assert again.status_code == 200 and again.json()["counted"] is False
    robin = env["as"]("user:robin")
    for pid in (a, b):
        r = robin.get(f"/api/bg/petitions/{pid}/release")
        assert r.status_code == 409
        assert not has_release_material(r.json())
        assert robin.get(f"/api/bg/petitions/{pid}").json()["approvals"] == 1


def test_t07_t09_reseal_invalidates_and_old_approvals_count_zero(env):
    v1 = seal(env)
    old = open_petition(env)["petition_id"]
    approve(env, "user:sage", old)
    v2 = seal(env)
    assert v1 != v2
    robin = env["as"]("user:robin")
    assert robin.get(f"/api/bg/petitions/{old}").json()["state"] == "Invalidated"
    new = open_petition(env)
    assert new["seal_version_id"] == v2
    assert new["approvals"] == 0
    approve(env, "user:rowan", new["petition_id"])
    assert robin.get(f"/api/bg/petitions/{new['petition_id']}/release").status_code == 409


def test_t08_write_once_columns(env, tmp_path):
    seal(env)
    pid = open_petition(env)["petition_id"]
    conn = sqlite3.connect(str(tmp_path / "test.sqlite"))
    for col, val in [("requester_id", "user:kit"), ("seal_version_id", "x"), ("expires_at", 9999999999),
                     ("requester_public_key", b"x"), ("fingerprint", b"x"), ("item_id", "y")]:
        with pytest.raises(sqlite3.IntegrityError, match="write-once"):
            conn.execute(f"UPDATE bg_petitions SET {col} = ? WHERE petition_id = ?", (val, pid))
    with pytest.raises(sqlite3.IntegrityError, match="immutable"):
        conn.execute("UPDATE bg_seal_versions SET threshold = 1")


def test_t10_key_validation_and_session_identity(env):
    seal(env)
    robin = env["as"]("user:robin")
    good = raw_public_key()
    bad_keys = [
        good[:64],                                # wrong length
        b"\x02" + good[1:33],                     # compressed
        b"\x04" + bytes(64),                      # identity-like / off curve
        b"\x04" + good[1:64] + bytes([good[64] ^ 1]),  # off curve
        b"\x04" + bytes([0xff]) * 64,             # coordinates out of range
    ]
    for k in bad_keys:
        r = robin.post("/api/bg/petitions", json={"item_id": "aws-root", "reason": "x", "requester_public_key": b64(k)})
        assert r.status_code == 422, k.hex()
        assert b64(k) not in r.text
    r = robin.post("/api/bg/petitions", json={"item_id": "aws-root", "reason": "x", "requester_public_key": b64(good),
                                             "requester_id": "user:kit"})
    assert r.status_code == 422
    p = open_petition(env)
    assert p["requester_id"] == "user:robin"


def test_t11_eligibility(env):
    seal(env, approvers=["user:sage", "user:rowan", "user:ash"])
    pid = open_petition(env)["petition_id"]
    assert approve(env, "user:wren", pid).status_code == 403
    assert approve(env, "user:kit", pid).status_code == 403
    assert env["as"]("user:wren").get(f"/api/bg/petitions/{pid}/approver-share").status_code == 404
    r = env["as"]("user:sage").post(f"/api/bg/petitions/{pid}/approvals", json={"envelope": b64(b"\x01short")})
    assert r.status_code == 422


def test_d1_self_approval_counts_once(env):
    seal(env)
    p = open_petition(env, requester="user:sage")
    approve(env, "user:sage", p["petition_id"])
    approve(env, "user:sage", p["petition_id"])
    s = env["as"]("user:sage").get(f"/api/bg/petitions/{p['petition_id']}").json()
    assert s["approvals"] == 1 and s["self_approved"] is True and s["state"] == "Open"


def test_t11_concurrent_approvals_count_once(env):
    seal(env)
    pid = open_petition(env)["petition_id"]
    results = []

    def go(who):
        results.append(approve(env, who, pid).status_code)

    # Pre-create clients so sign-in does not race.
    for a in APPROVERS:
        env["as"](a)
    threads = [threading.Thread(target=go, args=(a,)) for a in ["user:sage"] * 4 + ["user:rowan", "user:ash", "user:wren"]]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    rel = env["as"]("user:robin").get(f"/api/bg/petitions/{pid}/release").json()
    assert len(rel["envelopes"]) == 2
    s = env["as"]("user:robin").get(f"/api/bg/petitions/{pid}").json()
    assert len(set(s["approved_by"])) == len(s["approved_by"]) == 2


def test_t14_no_material_in_logs(env, caplog):
    caplog.set_level(logging.DEBUG)
    seal(env)
    p = open_petition(env)
    pid = p["petition_id"]
    share = env["as"]("user:sage").get(f"/api/bg/petitions/{pid}/approver-share").json()["approver_share"]
    env1 = fake_envelope()
    env["as"]("user:sage").post(f"/api/bg/petitions/{pid}/approvals", json={"envelope": b64(env1)})
    approve(env, "user:rowan", pid)
    rel = env["as"]("user:robin").get(f"/api/bg/petitions/{pid}/release").json()
    text = caplog.text
    secrets = [share, b64(env1), env1.hex(), rel["item_ciphertext"], rel["item_header"],
               base64.urlsafe_b64encode(env1).decode().rstrip("=")]
    secrets += [e["envelope"] for e in rel["envelopes"]]
    assert "route=/api/bg/petitions/{pid}/release" in text
    for s in secrets:
        assert s[:24] not in text


def test_t15_rotation_follow_up(env):
    seal(env)
    pid = open_petition(env)["petition_id"]
    approve(env, "user:sage", pid)
    approve(env, "user:rowan", pid)
    robin = env["as"]("user:robin")
    rel = robin.get(f"/api/bg/petitions/{pid}/release").json()
    assert "The credential stays valid until you rotate it in the system that issued it." in rel["retrieval_notice"]
    items = {i["item_id"]: i for i in robin.get("/api/bg/items").json()}
    assert items["aws-root"]["rotation_state"] == "rotation_required"
    assert robin.post("/api/bg/items/aws-root/rotation-confirmed").json()["rotation_state"] == "rotated"
    # The obligation is closed: Robin's old release no longer qualifies; the admin sees "not required".
    assert robin.post("/api/bg/items/aws-root/rotation-confirmed").status_code == 403
    assert env["as"]("user:quinn").post("/api/bg/items/aws-root/rotation-confirmed").status_code == 409
    for word in ("revoke", "destroy"):
        assert word not in rel["retrieval_notice"].lower()


# --- GR-ROT: who may record a rotation -------------------------------------


def release_to(env, requester: str = "user:robin", item_id: str = "aws-root") -> str:
    pid = open_petition(env, requester=requester, item_id=item_id)["petition_id"]
    approve(env, "user:sage", pid)
    approve(env, "user:rowan", pid)
    assert env["as"](requester).get(f"/api/bg/petitions/{pid}/release").status_code == 200
    return pid


def rotation_snapshot(env, item_id: str = "aws-root"):
    """Rotation state of the item, plus the record chain's receipt and full entries."""
    quinn = env["as"]("user:quinn")
    items = {i["item_id"]: i for i in quinn.get("/api/bg/items").json()}
    recs = quinn.get("/api/records/bg").json()
    return items[item_id]["rotation_state"], recs["receipt"], recs["entries"]


def confirm(env, who: str, item_id: str = "aws-root"):
    return env["as"](who).post(f"/api/bg/items/{item_id}/rotation-confirmed")


@pytest.mark.parametrize("who", ["user:quinn", "user:robin"])
def test_rotation_recorded_by_admin_or_the_releases_requester(env, who):
    seal(env)
    pid = release_to(env)
    assert env["as"]("user:robin").get(f"/api/bg/petitions/{pid}").json()["rotation_owed"] is True
    r = confirm(env, who)
    assert r.status_code == 200, r.text
    assert r.json()["rotation_state"] == "rotated"
    state, _, entries = rotation_snapshot(env)
    assert state == "rotated"
    assert entries[-1]["type"] == "rotation.confirmed"
    assert entries[-1]["data"] == {"item": "aws-root", "by": who}
    assert env["as"]("user:robin").get(f"/api/bg/petitions/{pid}").json()["rotation_owed"] is False


@pytest.mark.parametrize("who", ["user:sage", "user:ash", "user:kit"])
def test_rotation_refused_for_approver_or_unrelated_actor(env, who):
    """Approvers (one approved, one did not) and an engineer with no release are refused,
    and neither the rotation state nor the record chain changes."""
    seal(env)
    release_to(env)
    before = rotation_snapshot(env)
    r = confirm(env, who)
    assert r.status_code == 403
    assert r.json()["error"] == "not_rotation_party"
    assert rotation_snapshot(env) == before
    assert before[0] == "rotation_required"


def test_rotation_refused_for_an_earlier_closed_obligation(env):
    """Robin's release was already rotated. Kit's later release opens a new obligation: only Kit and the admin qualify."""
    seal(env)
    robin_pid = release_to(env, "user:robin")
    assert confirm(env, "user:robin").status_code == 200
    kit_pid = release_to(env, "user:kit")
    assert env["as"]("user:robin").get(f"/api/bg/petitions/{robin_pid}").json()["rotation_owed"] is False
    assert env["as"]("user:kit").get(f"/api/bg/petitions/{kit_pid}").json()["rotation_owed"] is True
    before = rotation_snapshot(env)
    assert confirm(env, "user:robin").status_code == 403
    assert rotation_snapshot(env) == before
    assert confirm(env, "user:kit").status_code == 200


def test_rotation_refused_after_reseal_for_an_old_version_release(env):
    """A release of the previous seal version does not qualify for an obligation on the new version."""
    seal(env)
    release_to(env, "user:robin")
    seal(env)  # reseal: new version, obligation cleared
    assert rotation_snapshot(env)[0] == "none"
    release_to(env, "user:kit")
    before = rotation_snapshot(env)
    assert confirm(env, "user:robin").status_code == 403
    assert rotation_snapshot(env) == before
    assert confirm(env, "user:kit").status_code == 200


def test_rotation_refused_for_a_release_of_another_item(env):
    seal(env, "aws-root")
    seal(env, "registrar-codes")
    release_to(env, "user:robin", "registrar-codes")
    release_to(env, "user:kit", "aws-root")
    before = rotation_snapshot(env, "aws-root")
    assert confirm(env, "user:robin", "aws-root").status_code == 403
    assert rotation_snapshot(env, "aws-root") == before
    assert confirm(env, "user:robin", "registrar-codes").status_code == 200
    assert rotation_snapshot(env, "aws-root")[0] == "rotation_required"


def test_rotation_refused_for_an_approved_but_unreleased_petition(env):
    """Holding an approved petition is not a release: nothing was served, nothing is owed."""
    seal(env)
    release_to(env, "user:kit")
    pid = open_petition(env, requester="user:robin")["petition_id"]
    approve(env, "user:sage", pid)
    approve(env, "user:rowan", pid)
    before = rotation_snapshot(env)
    assert confirm(env, "user:robin").status_code == 403
    assert rotation_snapshot(env) == before


def test_validation_errors_do_not_echo_input(env):
    robin = env["as"]("user:robin")
    r = robin.post("/api/bg/petitions", json={"item_id": "aws-root", "reason": "x", "requester_public_key": 12345,
                                             "secretish": "coven1:AAAAshouldnotecho"})
    assert r.status_code == 422
    assert "coven1:" not in r.text and "12345" not in r.text


def test_records_chain_is_consistent(env):
    seal(env)
    pid = open_petition(env)["petition_id"]
    approve(env, "user:sage", pid)
    from coven_service.common import verify_receipt

    rec = env["as"]("user:robin").get("/api/records/bg").json()
    assert verify_receipt(rec["entries"], rec["receipt"]) == "consistent"
    assert [e["seq"] for e in rec["entries"]] == list(range(1, len(rec["entries"]) + 1))
