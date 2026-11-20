"""Hosted mode: a private demo space per browser and app (spaces.py).

Each Browser below is one TestClient, so one cookie jar, on an https origin.
It switches personas by signing in again, the way both apps do. Fictional
data only.
"""

from __future__ import annotations

import base64
import hashlib
import logging
import os
import time
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from conftest import APPROVERS, FakeTime, approve, b64, fake_envelope, open_petition, raw_public_key, seal
from test_lastlight import DAY, make_vault, state

from coven_service.app import create_app
from coven_service.common import Clock, verify_receipt
from coven_service.spaces import SpaceConfig

BG, LL = "break-glass", "last-light"
ORIGIN = "https://coven.test"


class Browser:
    """One browser profile: one cookie jar; persona switches by sign-in, as in the apps."""

    def __init__(self, app, app_name: str, address: str = "203.0.113.7"):
        self.app_name = app_name
        self.client = TestClient(app, base_url=ORIGIN, headers={"X-Coven-App": app_name}, client=(address, 40000))
        self.persona: str | None = None

    def sign_in(self, user: str):
        r = self.client.post("/api/session", json={"user": user})
        self.persona = user if r.status_code == 200 else None
        return r

    def switch(self, user: str) -> None:
        if self.persona != user:
            r = self.sign_in(user)
            assert r.status_code == 200, r.text

    def as_(self, user: str) -> Persona:
        return Persona(self, user)

    def env(self, t: FakeTime) -> dict:
        """The env shape the conftest helpers take, bound to this one browser."""
        return {"as": self.as_, "time": t}

    def reset(self):
        r = self.client.post("/api/demo/reset")
        self.persona = None  # the reset ended every sign-in in this space
        return r

    def cookie(self, kind: str) -> str | None:
        slug = "bg" if self.app_name == BG else "ll"
        return self.client.cookies.get(f"__Host-coven_{kind}_{slug}")

    def space_file(self, root: Path) -> Path:
        return root / f"{hashlib.sha256(self.cookie('space').encode()).hexdigest()}.sqlite"


class Persona:
    """A view of one browser as one persona: it signs in first when another persona is current."""

    def __init__(self, b: Browser, user: str):
        self.b, self.user = b, user

    def get(self, *a, **kw):
        self.b.switch(self.user)
        return self.b.client.get(*a, **kw)

    def post(self, *a, **kw):
        self.b.switch(self.user)
        return self.b.client.post(*a, **kw)


def hosted_app(root: Path, t: FakeTime, **limits):
    cfg = SpaceConfig(dir=str(root), **{"per_client": 100, **limits})
    return create_app(None, clock=Clock(base=t), spaces=cfg)


@pytest.fixture
def hosted(tmp_path):
    t = FakeTime()
    root = tmp_path / "spaces"
    return {"app": hosted_app(root, t), "time": t, "root": root}


def space_files(root: Path) -> list[str]:
    return sorted(f for f in os.listdir(root) if f.endswith(".sqlite") and f != "registry.sqlite")


# --- isolation ---------------------------------------------------------------


def test_two_browsers_get_separate_private_spaces(hosted):
    app, t = hosted["app"], hosted["time"]
    a, b = Browser(app, BG), Browser(app, BG)
    assert a.sign_in("user:robin").status_code == 200
    assert b.sign_in("user:robin").status_code == 200
    assert a.cookie("space") and b.cookie("space") and a.cookie("space") != b.cookie("space")
    assert app.state.spaces.count() == 2
    seal(a.env(t))
    assert [i["item_id"] for i in a.as_("user:quinn").get("/api/bg/items").json()] == ["aws-root"]
    # B sees none of A's items, enrolled keys or records.
    assert b.as_("user:robin").get("/api/bg/items").json() == []
    assert b.as_("user:robin").get("/api/directory").json() == []
    assert b.as_("user:robin").get("/api/records/bg").json()["entries"] == []
    assert len(space_files(hosted["root"])) == 2


def test_a_moves_the_clock_and_resets_while_b_completes_its_petition(hosted):
    app, t = hosted["app"], hosted["time"]
    a, b = Browser(app, BG), Browser(app, BG)
    ea, eb = a.env(t), b.env(t)
    seal(ea)
    seal(eb)
    pa = open_petition(ea)["petition_id"]
    pb = open_petition(eb, window=900)["petition_id"]
    approve(eb, "user:sage", pb)

    # A moves its demo clock an hour: A's petition expires. B's clock and petition do not move.
    assert a.as_("user:robin").post("/api/demo/clock", json={"advance_seconds": 3600}).json()["offset_seconds"] == 3600
    assert a.as_("user:robin").get(f"/api/bg/petitions/{pa}").json()["state"] == "Expired"
    assert b.as_("user:robin").get("/api/demo/clock").json()["offset_seconds"] == 0
    assert b.as_("user:robin").get(f"/api/bg/petitions/{pb}").json()["state"] == "Open"
    # B cannot reach A's petition; it does not exist in B's space.
    assert b.as_("user:robin").get(f"/api/bg/petitions/{pa}").status_code == 404

    # A resets in the middle of B's approvals.
    assert a.reset().status_code == 200
    approve(eb, "user:rowan", pb)
    rel = b.as_("user:robin").get(f"/api/bg/petitions/{pb}/release")
    assert rel.status_code == 200, rel.text
    assert {e["approver_id"] for e in rel.json()["envelopes"]} == {"user:sage", "user:rowan"}
    assert b.as_("user:robin").get(f"/api/bg/petitions/{pb}").json()["state"] == "Released"
    recs = b.as_("user:robin").get("/api/records/bg").json()
    assert verify_receipt(recs["entries"], recs["receipt"]) == "consistent"

    # A's space is empty again, with its clock back at zero, and still A's own.
    assert a.as_("user:robin").get("/api/bg/items").json() == []
    assert a.as_("user:robin").get("/api/demo/clock").json()["offset_seconds"] == 0
    assert app.state.spaces.count() == 2
    # B's persona sessions survived A's reset and switches.
    assert b.client.get("/api/session").json()["user"] == "user:robin"


def test_b_completes_a_recovery_while_a_moves_the_clock_and_resets(hosted):
    app, t = hosted["app"], hosted["time"]
    a, b = Browser(app, LL), Browser(app, LL)
    ea, eb = a.env(t), b.env(t)
    va, vb = make_vault(ea), make_vault(eb)
    assert b.as_("user:mara").post("/api/demo/clock", json={"advance_seconds": 47 * DAY}).status_code == 200
    assert state(eb, vb) == "Handover"
    assert state(ea, va) == "Lit"
    ada = b.as_("user:ada")
    rid = ada.post(f"/api/ll/vaults/{vb}/recoveries", json={"public_key": b64(raw_public_key())}).json()["recovery"]["recovery_id"]
    for who in ("user:ada", "user:bram"):
        assert b.as_(who).post(f"/api/ll/recoveries/{rid}/shares", json={"envelope": b64(fake_envelope())}).status_code == 200

    # A moves its clock 400 days and resets while B's recovery waits for a third share.
    assert a.as_("user:mara").post("/api/demo/clock", json={"advance_seconds": 400 * DAY}).status_code == 200
    assert state(ea, va) == "Handover"
    assert a.reset().status_code == 200
    assert a.as_("user:mara").get("/api/ll/vaults").json() == []

    assert b.as_("user:cleo").post(f"/api/ll/recoveries/{rid}/shares", json={"envelope": b64(fake_envelope())}).status_code == 200
    pkg = ada.get(f"/api/ll/recoveries/{rid}/package")
    assert pkg.status_code == 200, pkg.text
    assert len(pkg.json()["envelopes"]) == 3
    assert state(eb, vb) == "Released"
    bundle = b.as_("user:cleo").get(f"/api/ll/vaults/{vb}/bundle").json()
    assert bundle["format"] == "coven/v1"  # the offline bundle format is unchanged
    assert verify_receipt(bundle["record"]["entries"], bundle["record"]["receipt"]) == "consistent"


def test_each_app_has_its_own_space(hosted):
    app = hosted["app"]
    ll = Browser(app, LL)
    assert ll.sign_in("user:ada").status_code == 200
    # The same browser on Break Glass, even sending Last Light's cookies under Break Glass's names, has no space.
    forged = TestClient(app, base_url=ORIGIN, headers={"X-Coven-App": BG}, cookies={
        "__Host-coven_space_bg": ll.cookie("space"), "__Host-coven_session_bg": ll.cookie("session")})
    assert forged.get("/api/session").status_code == 401
    assert forged.get("/api/bg/items").status_code == 401
    # No app header: no space, and no sign-in.
    bare = TestClient(app, base_url=ORIGIN, cookies={"__Host-coven_space_ll": ll.cookie("space")})
    assert bare.get("/api/session").status_code == 401
    assert bare.post("/api/session", json={"user": "user:ada"}).status_code == 400
    assert app.state.spaces.count() == 1


# --- sessions and cookies ----------------------------------------------------


def test_cookies_are_host_only_secure_httponly_strict_and_persistent(hosted):
    r = Browser(hosted["app"], LL).sign_in("user:ada")
    cookies = r.headers.get_list("set-cookie")
    assert sorted(c.split("=", 1)[0] for c in cookies) == ["__Host-coven_session_ll", "__Host-coven_space_ll"]
    for c in cookies:
        attrs = [p.strip().lower() for p in c.split(";")[1:]]
        assert {"secure", "httponly", "path=/", "samesite=strict", f"max-age={7 * 86400}"} <= set(attrs), c
        assert not any(p.startswith("domain") for p in attrs), c  # host-only


def test_a_session_survives_reload_and_a_new_browser_starts_empty(hosted):
    app = hosted["app"]
    b = Browser(app, BG)
    assert b.sign_in("user:sage").status_code == 200
    again = b.client.get("/api/session")  # a reload sends the same cookies
    assert again.json()["user"] == "user:sage"
    assert len(again.headers.get_list("set-cookie")) == 2  # both refreshed for the full lifetime
    assert Browser(app, BG).client.get("/api/session").status_code == 401


def test_an_unknown_space_cookie_gets_nothing_and_sign_in_issues_a_new_one(hosted):
    app = hosted["app"]
    stale = TestClient(app, base_url=ORIGIN, headers={"X-Coven-App": BG}, cookies={"__Host-coven_space_bg": "A" * 43})
    assert stale.get("/api/bg/items").status_code == 401
    assert stale.get("/api/demo/clock").status_code == 401
    assert stale.post("/api/demo/clock", json={"advance_seconds": 60}).status_code == 401
    r = stale.post("/api/session", json={"user": "user:robin"})
    assert r.status_code == 200
    issued = [c.split(";")[0].split("=", 1)[1] for c in r.headers.get_list("set-cookie") if c.startswith("__Host-coven_space_bg=")]
    assert len(issued) == 1 and issued[0] != "A" * 43
    assert app.state.spaces.count() == 1


def test_reset_empties_only_the_callers_space_and_needs_no_space(hosted):
    app, t = hosted["app"], hosted["time"]
    assert Browser(app, BG).reset().status_code == 200  # nothing to reset, and no space is made
    assert app.state.spaces.count() == 0
    a = Browser(app, BG)
    seal(a.env(t))
    r = a.reset()
    assert any(c.startswith("__Host-coven_session_bg=") and "max-age=0" in c.lower() for c in r.headers.get_list("set-cookie"))
    assert a.client.get("/api/session").status_code == 401  # signed out, space kept
    assert a.as_("user:quinn").get("/api/bg/items").json() == []
    assert app.state.spaces.count() == 1


# --- bounds on a small server -------------------------------------------------


def test_when_full_only_an_idle_space_makes_room(tmp_path):
    t = FakeTime()
    app = hosted_app(tmp_path, t, max_spaces=2, min_idle_seconds=600)
    a, b, c = (Browser(app, BG, f"198.51.100.{i}") for i in (1, 2, 3))
    assert a.sign_in("user:robin").status_code == 200
    t.t += 1
    assert b.sign_in("user:robin").status_code == 200
    r = c.sign_in("user:robin")
    assert r.status_code == 503 and r.json()["error"] == "demo_busy"  # both in use: nobody is pushed out
    assert app.state.spaces.count() == 2 and len(space_files(tmp_path)) == 2
    t.t += 601
    assert b.client.get("/api/session").status_code == 200  # B is used again; A stays idle
    assert c.sign_in("user:robin").status_code == 200  # A, the least recently used idle space, made room
    assert a.client.get("/api/session").status_code == 401
    assert b.client.get("/api/session").status_code == 200
    assert app.state.spaces.count() == 2 and len(space_files(tmp_path)) == 2


def test_one_address_is_capped_and_recycles_only_its_own_idle_spaces(tmp_path):
    t = FakeTime()
    app = hosted_app(tmp_path, t, per_client=2, min_idle_seconds=600)
    x1, x2, x3 = (Browser(app, BG, "192.0.2.10") for _ in range(3))
    other = Browser(app, BG, "192.0.2.99")
    assert x1.sign_in("user:robin").status_code == 200
    t.t += 1
    assert x2.sign_in("user:robin").status_code == 200
    r = x3.sign_in("user:robin")
    assert r.status_code == 429 and r.json()["error"] == "too_many_demo_spaces"
    assert other.sign_in("user:robin").status_code == 200  # another address is not affected
    t.t += 601
    assert x3.sign_in("user:robin").status_code == 200  # x1, its own oldest idle space, made room
    assert x1.client.get("/api/session").status_code == 401
    assert other.client.get("/api/session").status_code == 200
    assert app.state.spaces.count() == 3


def test_idle_spaces_are_deleted_on_wall_time_never_on_the_demo_clock(tmp_path):
    t = FakeTime()
    app = hosted_app(tmp_path, t, idle_seconds=3600)
    a, b = Browser(app, LL), Browser(app, LL)
    assert a.sign_in("user:ada").status_code == 200
    assert b.sign_in("user:ada").status_code == 200
    fa, fb = a.space_file(tmp_path), b.space_file(tmp_path)
    # Moving the demo clock 400 days does not age a space.
    assert a.client.post("/api/demo/clock", json={"advance_seconds": 400 * DAY}).status_code == 200
    assert app.state.spaces.sweep() == 0 and fa.exists()
    t.t += 1800
    assert b.client.get("/api/session").status_code == 200  # B is used; A is not
    t.t += 1801
    assert app.state.spaces.sweep() == 1
    assert not fa.exists() and fb.exists()
    assert a.client.get("/api/session").status_code == 401
    # Past the limit, a request ends the space at once, without waiting for a sweep.
    t.t += 3601
    assert b.client.get("/api/session").status_code == 401
    assert not fb.exists() and app.state.spaces.count() == 0


def test_stray_space_files_are_removed_after_an_hour(tmp_path):
    t = FakeTime()
    app = hosted_app(tmp_path, t)
    old, new = tmp_path / f"{'a' * 64}.sqlite", tmp_path / f"{'b' * 64}.sqlite-journal"
    old.write_bytes(b"x")
    new.write_bytes(b"x")
    os.utime(old, (time.time() - 7200, time.time() - 7200))
    app.state.spaces.sweep()
    assert not old.exists() and new.exists()


def test_a_space_is_size_capped_and_a_refused_write_changes_nothing(tmp_path):
    t = FakeTime()
    cap = 320 * 1024
    app = hosted_app(tmp_path, t, max_bytes=cap)
    b = Browser(app, BG)
    e = b.env(t)
    first = seal(e)
    quinn = b.as_("user:quinn")
    big = lambda: b64(b"\x02" + os.urandom(12) + os.urandom(60_000) + os.urandom(16))  # noqa: E731
    versions, r = [first], None
    for _ in range(10):
        vid = str(uuid.uuid4())
        r = quinn.post("/api/bg/items/aws-root/seal-versions", json={
            "seal_version_id": vid, "threshold": 2, "approver_ids": APPROVERS, "header": big(), "ciphertext": big(),
            "approver_shares": {a: b64(fake_envelope()) for a in APPROVERS}})
        if r.status_code != 200:
            break
        versions.append(vid)
    assert r is not None and r.status_code == 507 and r.json()["error"] == "demo_space_full"
    assert b.space_file(tmp_path).stat().st_size <= cap
    # The refused seal left nothing half written: the last accepted version is still current.
    assert quinn.get("/api/bg/items").json()[0]["seal_version_id"] == versions[-1]
    recs = quinn.get("/api/records/bg").json()
    assert verify_receipt(recs["entries"], recs["receipt"]) == "consistent"
    # Reset frees the space for a new setup.
    assert b.reset().status_code == 200
    seal(b.env(t))
    assert len(quinn.get("/api/bg/items").json()) == 1


def test_large_request_bodies_are_refused(hosted):
    b = Browser(hosted["app"], BG)
    assert b.sign_in("user:quinn").status_code == 200
    r = b.client.post("/api/bg/items", content=b"x" * (512 * 1024 + 1), headers={"Content-Type": "application/json"})
    assert r.status_code == 413


# --- what is stored and logged --------------------------------------------------


def test_tokens_and_material_stay_out_of_logs_files_and_registry(hosted, caplog):
    caplog.set_level(logging.DEBUG)
    app, t, root = hosted["app"], hosted["time"], hosted["root"]
    b = Browser(app, BG)
    e = b.env(t)
    seal(e)
    pid = open_petition(e)["petition_id"]
    share = b.as_("user:sage").get(f"/api/bg/petitions/{pid}/approver-share").json()["approver_share"]
    approve(e, "user:sage", pid)
    approve(e, "user:rowan", pid)
    rel = b.as_("user:robin").get(f"/api/bg/petitions/{pid}/release").json()
    space, session = b.cookie("space"), b.cookie("session")
    space_id = hashlib.sha256(space.encode()).hexdigest()
    text = caplog.text
    material = [share, rel["item_ciphertext"], rel["item_header"], *(x["envelope"] for x in rel["envelopes"])]
    for s in [space, session, space_id, *material]:
        assert s[:24] not in text
    assert "space created live=1" in text  # spaces are logged as counts only
    # Only the token's hash names the file; the registry holds no token.
    assert space_files(root) == [f"{space_id}.sqlite"]
    stored = b"".join(p.read_bytes() for p in root.iterdir() if p.name.startswith("registry"))
    assert space.encode() not in stored and session.encode() not in stored
    assert all(space not in name for name in os.listdir(root))
    assert base64.b64decode(rel["item_ciphertext"])  # the package itself is intact


def test_shared_mode_is_unchanged(env):
    robin = env["as"]("user:robin")
    assert robin.get("/api/demo/space").json() == {"private": False}
    assert robin.get("/api/session").json()["user"] == "user:robin"
    assert env["app"].state.spaces is None
