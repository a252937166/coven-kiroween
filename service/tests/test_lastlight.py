"""Last Light lantern lifecycle, online recovery and bundle (proposal 3.3, 4.1;
invariants 6 and 7's Last Light side). Fictional family only."""

from __future__ import annotations

import uuid

from conftest import b64, fake_envelope, fake_sym, has_release_material, raw_public_key

DAY = 86400
TRUSTEES = ["user:ada", "user:bram", "user:cleo", "user:dov", "user:esme"]


def make_vault(env) -> str:
    for t in TRUSTEES:
        env["as"](t).post("/api/enroll", json={"public_key": b64(raw_public_key())})
    vid = str(uuid.uuid4())
    mara = env["as"]("user:mara")
    r = mara.post("/api/ll/vaults", json={
        "vault_id": vid, "name": "Hollow family (fictional)", "threshold": 3, "trustee_ids": TRUSTEES,
        "header": b64(fake_sym()), "owner_key_blob": b64(fake_envelope(32)),
        "trustee_shares": {t: b64(fake_envelope()) for t in TRUSTEES}, "cadence_days": 30, "vigil_days": 14,
    })
    assert r.status_code == 200, r.text
    for item, er in (("letter", None), ("future-letter", "2099-01-01")):
        r = mara.post(f"/api/ll/vaults/{vid}/items", json={
            "item_id": item, "label": f"{item} (fictional)", "deliver_to": ["Ada"], "earliest_release": er,
            "wrapped_key": b64(fake_sym(32)), "ciphertext": b64(fake_sym())})
        assert r.status_code == 200, r.text
    return vid


def state(env, vid, who="user:mara"):
    return env["as"](who).get(f"/api/ll/vaults/{vid}").json()["state"]


def test_lantern_states_follow_the_clock(env):
    vid = make_vault(env)
    assert state(env, vid) == "Lit"
    env["time"].t += 30 * DAY
    assert state(env, vid) == "Flicker"
    env["time"].t += 3 * DAY
    assert state(env, vid) == "Vigil"
    env["time"].t += 14 * DAY
    assert state(env, vid) == "Handover"
    mail = env["as"]("user:ada").get("/api/mail", params={"app_name": "last-light"}).json()
    assert any("Handover started" in m["subject"] and "not proof of death" in m["body"] for m in mail)


def test_checkin_in_vigil_and_handover_cancels(env):
    vid = make_vault(env)
    env["time"].t += 34 * DAY
    assert state(env, vid) == "Vigil"
    assert env["as"]("user:mara").post(f"/api/ll/vaults/{vid}/checkin").json()["state"] == "Lit"
    env["time"].t += 47 * DAY
    assert state(env, vid) == "Handover"
    ada = env["as"]("user:ada")
    r = ada.post(f"/api/ll/vaults/{vid}/recoveries", json={"public_key": b64(raw_public_key())})
    rid = r.json()["recovery"]["recovery_id"]
    env["as"]("user:bram").post(f"/api/ll/recoveries/{rid}/shares", json={"envelope": b64(fake_envelope())})
    assert env["as"]("user:mara").post(f"/api/ll/vaults/{vid}/checkin").json()["state"] == "Lit"
    assert ada.get(f"/api/ll/recoveries/{rid}/package").status_code == 410
    r = env["as"]("user:cleo").post(f"/api/ll/recoveries/{rid}/shares", json={"envelope": b64(fake_envelope())})
    assert r.status_code == 409


def test_recovery_needs_handover_and_quorum_and_only_serves_recoverer(env):
    vid = make_vault(env)
    ada = env["as"]("user:ada")
    assert ada.post(f"/api/ll/vaults/{vid}/recoveries", json={"public_key": b64(raw_public_key())}).status_code == 409
    env["time"].t += 47 * DAY
    rid = ada.post(f"/api/ll/vaults/{vid}/recoveries", json={"public_key": b64(raw_public_key())}).json()["recovery"]["recovery_id"]
    for t in ("user:ada", "user:bram"):
        env["as"](t).post(f"/api/ll/recoveries/{rid}/shares", json={"envelope": b64(fake_envelope())})
    r = ada.get(f"/api/ll/recoveries/{rid}/package")
    assert r.status_code == 409 and not has_release_material(r.json())
    again = env["as"]("user:bram").post(f"/api/ll/recoveries/{rid}/shares", json={"envelope": b64(fake_envelope())})
    assert again.json()["counted"] is False
    env["as"]("user:cleo").post(f"/api/ll/recoveries/{rid}/shares", json={"envelope": b64(fake_envelope())})
    assert env["as"]("user:bram").get(f"/api/ll/recoveries/{rid}/package").status_code == 404
    pkg = ada.get(f"/api/ll/recoveries/{rid}/package").json()
    assert len(pkg["envelopes"]) == 3
    items = {i["item_id"]: i for i in pkg["items"]}
    assert "ciphertext" in items["letter"]
    assert items["future-letter"].get("withheld") is True and "ciphertext" not in items["future-letter"]
    assert state(env, vid) == "Released"
    assert env["as"]("user:mara").post(f"/api/ll/vaults/{vid}/checkin").status_code == 409


def test_bundle_has_no_shares_and_includes_every_item(env):
    vid = make_vault(env)
    b = env["as"]("user:cleo").get(f"/api/ll/vaults/{vid}/bundle").json()
    assert b["format"] == "coven/v1"
    assert {i["id"] for i in b["items"]} == {"letter", "future-letter"}
    text = str(b)
    assert "share" not in text.replace("share_submitted", "")
    from coven_service.common import verify_receipt

    assert verify_receipt(b["record"]["entries"], b["record"]["receipt"]) == "consistent"
    assert env["as"]("user:robin").get(f"/api/ll/vaults/{vid}/bundle").status_code == 404


def test_my_share_only_for_that_trustee(env):
    vid = make_vault(env)
    assert env["as"]("user:ada").get(f"/api/ll/vaults/{vid}/my-share").status_code == 200
    assert env["as"]("user:mara").get(f"/api/ll/vaults/{vid}/my-share").status_code == 404
    assert env["as"]("user:robin").get(f"/api/ll/vaults/{vid}/my-share").status_code == 404


def test_demo_clock_moves_forward_only(env):
    c = env["as"]("user:mara")
    assert c.post("/api/demo/clock", json={"advance_seconds": -5}).status_code == 422
    assert c.post("/api/demo/clock", json={"advance_seconds": 0}).status_code == 422
    assert c.post("/api/demo/clock", json={"advance_seconds": 60}).json()["offset_seconds"] == 60


def test_records_endpoint_observes_lantern_state(env):
    vid = make_vault(env)
    env["time"].t += 31 * DAY  # no vault read in between
    rec = env["as"]("user:ada").get(f"/api/records/ll:{vid}").json()
    assert rec["entries"][-1]["type"] == "lantern.flicker"
    assert rec["receipt"] == {"length": len(rec["entries"]), "head": rec["entries"][-1]["hash"]}


def test_records_snapshot_under_concurrent_appends(env):
    """A receipt never names more rows than the response holds, while another
    client appends records concurrently."""
    import threading

    from coven_service.common import verify_receipt

    vid = make_vault(env)
    ada, bram = env["as"]("user:ada"), env["as"]("user:bram")
    stop = threading.Event()

    def writer():
        while not stop.is_set():
            bram.post(f"/api/ll/vaults/{vid}/card-issued")

    t = threading.Thread(target=writer)
    t.start()
    try:
        lengths = []
        for _ in range(40):
            rec = ada.get(f"/api/records/ll:{vid}").json()
            assert rec["receipt"]["length"] == len(rec["entries"])
            assert verify_receipt(rec["entries"], rec["receipt"]) == "consistent"
            lengths.append(len(rec["entries"]))
    finally:
        stop.set()
        t.join()
    assert lengths[-1] > lengths[0]  # appends really interleaved with reads


def test_supplement_after_release_and_no_checkin_revival(env):
    vid = make_vault(env)
    env["time"].t += 47 * DAY
    ada = env["as"]("user:ada")
    rid = ada.post(f"/api/ll/vaults/{vid}/recoveries", json={"public_key": b64(raw_public_key())}).json()["recovery"]["recovery_id"]
    for t in ("user:ada", "user:bram", "user:cleo"):
        env["as"](t).post(f"/api/ll/recoveries/{rid}/shares", json={"envelope": b64(fake_envelope())})
    assert ada.get(f"/api/ll/recoveries/{rid}/package").status_code == 200
    assert state(env, vid) == "Released"
    # Material was served: the owner cannot check in to undo it.
    assert env["as"]("user:mara").post(f"/api/ll/vaults/{vid}/checkin").status_code == 409
    # Another trustee may add a share to the same recovery; a repeat does not count twice.
    r = env["as"]("user:dov").post(f"/api/ll/recoveries/{rid}/shares", json={"envelope": b64(fake_envelope())})
    assert r.status_code == 200 and r.json()["counted"] is True
    again = env["as"]("user:dov").post(f"/api/ll/recoveries/{rid}/shares", json={"envelope": b64(fake_envelope())})
    assert again.json()["counted"] is False
    pkg = ada.get(f"/api/ll/recoveries/{rid}/package").json()
    assert len(pkg["envelopes"]) == 4
    assert state(env, vid) == "Released"
    assert env["as"]("user:bram").get(f"/api/ll/recoveries/{rid}/package").status_code == 404
    assert env["as"]("user:robin").post(f"/api/ll/recoveries/{rid}/shares", json={"envelope": b64(fake_envelope())}).status_code == 404
