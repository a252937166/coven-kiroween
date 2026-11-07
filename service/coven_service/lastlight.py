"""Last Light: vault, lantern lifecycle, online recovery and bundle export.

Lantern: Lit -> Flicker -> Vigil -> Handover -> Released.
- Lit until the check-in is due.
- Flicker: the check-in was missed. The owner is reminded.
- Vigil: the grace period. A check-in still cancels everything.
- Handover: the vigil ended. Trustees are told; one may open a recovery.
- Released: a recovery reached quorum and the encrypted package was served
  to the recovering trustee. The service cannot know whether that browser
  then rebuilt and verified the key; Released means "material was served".
A check-in in any state before Released relights the lantern and cancels any
pending handover and open recovery. A missed check-in is a signal, not proof
of death. Time only moves forward.

The service controls when it starts and completes this online handover. It
cannot stop a quorum that holds the bundle and k shares from recovering
offline at any time.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import date, datetime, timezone

from .common import (
    Rejected,
    append_record,
    b64,
    chain_entries,
    check_envelope,
    check_sym_blob,
    fingerprint,
    iso,
    notify,
    receipt,
    validate_public_key,
)

APP = "last-light"
DAY = 86400
PRE_RELEASE = ("Lit", "Flicker", "Vigil", "Handover")


def chain_of(vault_id: str) -> str:
    return f"ll:{vault_id}"


def _vault(conn, vault_id: str) -> sqlite3.Row:
    v = conn.execute("SELECT * FROM ll_vaults WHERE vault_id = ?", (vault_id,)).fetchone()
    if v is None:
        raise Rejected(404, "not_found")
    return v


def _trustees(v) -> list[str]:
    return json.loads(v["trustee_ids"])


def _member(v, user: str) -> bool:
    return user == v["owner_id"] or user in _trustees(v)


def derived_state(v, now: int) -> str:
    if v["released_at"] is not None:
        return "Released"
    due = v["last_checkin_at"] + v["cadence_seconds"]
    if now < due:
        return "Lit"
    if now < due + v["flicker_seconds"]:
        return "Flicker"
    if now < due + v["flicker_seconds"] + v["vigil_seconds"]:
        return "Vigil"
    return "Handover"


def _observe(conn, v, now: int) -> sqlite3.Row:
    """Record and announce any transition the clock has caused since last look."""
    state = derived_state(v, now)
    if state == v["observed_state"]:
        return v
    vid = v["vault_id"]
    conn.execute("UPDATE ll_vaults SET observed_state = ? WHERE vault_id = ?", (state, vid))
    rec = append_record(conn, chain_of(vid), now, f"lantern.{state.lower()}", {"vault": vid})
    owner = v["owner_id"]
    if state == "Flicker":
        notify(conn, APP, owner, "Your lantern is flickering",
               f"You missed a check-in for \"{v['name']}\". Check in to keep it lit. Receipt {rec['length']}:{rec['head']}", now)
    elif state == "Vigil":
        notify(conn, APP, owner, "The vigil has started",
               f"\"{v['name']}\" is in its grace period. A check-in now cancels the handover. Receipt {rec['length']}:{rec['head']}", now)
    elif state == "Handover":
        for t in _trustees(v):
            notify(conn, APP, t, f"Handover started for {v['name']}",
                   f"The owner missed a check-in and the vigil ended. This is a signal, not proof of death. "
                   f"Any {v['threshold']} trustees can now recover the vault together in Last Light. "
                   f"Receipt {rec['length']}:{rec['head']}", now)
    return _vault(conn, vid)


def _public(conn, v, now: int, user: str) -> dict:
    v = _observe(conn, v, now)
    due = v["last_checkin_at"] + v["cadence_seconds"]
    items = conn.execute(
        "SELECT item_id, label, deliver_to, earliest_release, created_at FROM ll_items WHERE vault_id = ? ORDER BY rowid",
        (v["vault_id"],),
    ).fetchall()
    rec = conn.execute(
        "SELECT * FROM ll_recoveries WHERE vault_id = ? AND state IN ('Open', 'Complete') ORDER BY created_at DESC LIMIT 1",
        (v["vault_id"],),
    ).fetchone()
    return {
        "vault_id": v["vault_id"],
        "name": v["name"],
        "owner_id": v["owner_id"],
        "role": "owner" if user == v["owner_id"] else "trustee",
        "threshold": v["threshold"],
        "trustee_ids": _trustees(v),
        "state": derived_state(v, now),
        "last_checkin_at": iso(v["last_checkin_at"]),
        "next_due_at": iso(due),
        "vigil_starts_at": iso(due + v["flicker_seconds"]),
        "handover_at": iso(due + v["flicker_seconds"] + v["vigil_seconds"]),
        "cadence_days": v["cadence_seconds"] // DAY,
        "vigil_days": v["vigil_seconds"] // DAY,
        "server_now": iso(now),
        "items": [
            {"item_id": i["item_id"], "label": i["label"], "deliver_to": json.loads(i["deliver_to"]),
             "earliest_release": i["earliest_release"]}
            for i in items
        ],
        "recovery": _recovery_status(conn, rec) if rec else None,
        "receipt": receipt(conn, chain_of(v["vault_id"])),
    }


def _recovery_status(conn, r) -> dict:
    submitted = [x["trustee_id"] for x in conn.execute(
        "SELECT trustee_id FROM ll_recovery_shares WHERE recovery_id = ? ORDER BY created_at, trustee_id", (r["recovery_id"],)
    ).fetchall()]
    return {
        "recovery_id": r["recovery_id"],
        "recoverer_id": r["recoverer_id"],
        "public_key": b64(r["public_key"]),
        "fingerprint": r["fingerprint"].hex(),
        "state": r["state"],
        "submitted_by": submitted,
        "created_at": iso(r["created_at"]),
    }


# ---------------------------------------------------------------------------


def create_vault(conn, now: int, owner: str, body: dict) -> dict:
    vault_id = body["vault_id"]
    try:
        uuid.UUID(vault_id, version=4)
    except ValueError:
        raise Rejected(422, "invalid_vault_id") from None
    if conn.execute("SELECT 1 FROM ll_vaults WHERE vault_id = ?", (vault_id,)).fetchone():
        raise Rejected(409, "vault_exists")
    trustees: list[str] = body["trustee_ids"]
    k = body["threshold"]
    if len(set(trustees)) != len(trustees) or owner in trustees or not (2 <= k <= len(trustees) <= 255):
        raise Rejected(422, "invalid_threshold")
    shares: dict[str, bytes] = body["trustee_shares"]
    if set(shares) != set(trustees):
        raise Rejected(422, "share_set_mismatch")
    for t in trustees:
        if not conn.execute("SELECT 1 FROM enrolled_keys WHERE account_id = ?", (t,)).fetchone():
            raise Rejected(422, "trustee_not_enrolled", t)
        check_envelope(shares[t])
    check_envelope(body["owner_key_blob"])
    check_sym_blob(body["header"], "header")
    cadence, flicker, vigil = body["cadence_days"], body.get("flicker_days", 3), body["vigil_days"]
    if cadence not in (30, 60, 90) or not (1 <= vigil <= 60) or not (1 <= flicker <= 14):
        raise Rejected(422, "invalid_schedule")
    conn.execute(
        "INSERT INTO ll_vaults(vault_id, owner_id, name, threshold, trustee_ids, header, owner_key_blob,"
        " cadence_seconds, flicker_seconds, vigil_seconds, last_checkin_at, observed_state, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Lit', ?)",
        (vault_id, owner, body["name"], k, json.dumps(trustees), body["header"], body["owner_key_blob"],
         cadence * DAY, flicker * DAY, vigil * DAY, now, now),
    )
    for t in trustees:
        conn.execute("INSERT INTO ll_trustee_shares(vault_id, trustee_id, blob) VALUES (?, ?, ?)", (vault_id, t, shares[t]))
    append_record(conn, chain_of(vault_id), now, "vault.created",
                  {"vault": vault_id, "owner": owner, "threshold": k, "trustees": trustees})
    for t in trustees:
        notify(conn, APP, t, f"You are a trustee of {body['name']}",
               f"{owner} chose you as one of {len(trustees)} trustees. Any {k} of you can open this vault together. "
               "Your share is a recovery share: store a printed card like a key.", now)
    return {"vault_id": vault_id}


def add_item(conn, now: int, owner: str, vault_id: str, body: dict) -> dict:
    v = _vault(conn, vault_id)
    if owner != v["owner_id"]:
        raise Rejected(404, "not_found")
    if v["released_at"] is not None:
        raise Rejected(409, "vault_released")
    item_id = body["item_id"]
    if conn.execute("SELECT 1 FROM ll_items WHERE vault_id = ? AND item_id = ?", (vault_id, item_id)).fetchone():
        raise Rejected(409, "item_exists")
    er = body.get("earliest_release")
    if er is not None:
        try:
            date.fromisoformat(er)
        except ValueError:
            raise Rejected(422, "invalid_date") from None
    check_sym_blob(body["wrapped_key"], "wrapped key")
    check_sym_blob(body["ciphertext"], "ciphertext")
    conn.execute(
        "INSERT INTO ll_items(vault_id, item_id, label, deliver_to, earliest_release, wrapped_key, ciphertext, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (vault_id, item_id, body["label"], json.dumps(body["deliver_to"]), er, body["wrapped_key"], body["ciphertext"], now),
    )
    append_record(conn, chain_of(vault_id), now, "item.sealed",
                  {"vault": vault_id, "item": item_id, "label": body["label"], "earliest_release": er})
    return {"item_id": item_id}


def list_vaults(conn, now: int, user: str) -> list[dict]:
    rows = conn.execute("SELECT * FROM ll_vaults ORDER BY created_at").fetchall()
    return [_public(conn, v, now, user) for v in rows if _member(v, user)]


def get_vault(conn, now: int, user: str, vault_id: str) -> dict:
    v = _vault(conn, vault_id)
    if not _member(v, user):
        raise Rejected(404, "not_found")
    return _public(conn, v, now, user)


def owner_key(conn, now: int, user: str, vault_id: str) -> dict:
    v = _vault(conn, vault_id)
    if user != v["owner_id"]:
        raise Rejected(404, "not_found")
    return {"owner_key_blob": b64(v["owner_key_blob"])}


def my_share(conn, now: int, user: str, vault_id: str) -> dict:
    """A trustee's own digital share, encrypted to that trustee's long-term key."""
    v = _vault(conn, vault_id)
    if user not in _trustees(v):
        raise Rejected(404, "not_found")
    row = conn.execute("SELECT blob FROM ll_trustee_shares WHERE vault_id = ? AND trustee_id = ?", (vault_id, user)).fetchone()
    return {"share_blob": b64(row["blob"])}


def card_printed(conn, now: int, user: str, vault_id: str) -> dict:
    """Records that a card was issued. The request carries no share material."""
    v = _vault(conn, vault_id)
    if user not in _trustees(v):
        raise Rejected(404, "not_found")
    rec = append_record(conn, chain_of(vault_id), now, "card.issued", {"vault": vault_id, "trustee": user})
    return {"receipt": rec}


def checkin(conn, now: int, user: str, vault_id: str) -> dict:
    v = _vault(conn, vault_id)
    if user != v["owner_id"]:
        raise Rejected(404, "not_found")
    v = _observe(conn, v, now)
    if v["released_at"] is not None:
        raise Rejected(409, "vault_released")
    previous = derived_state(v, now)
    conn.execute("UPDATE ll_vaults SET last_checkin_at = ?, observed_state = 'Lit' WHERE vault_id = ?", (now, vault_id))
    cancelled = [r["recovery_id"] for r in conn.execute(
        "SELECT recovery_id FROM ll_recoveries WHERE vault_id = ? AND state = 'Open'", (vault_id,)).fetchall()]
    for rid in cancelled:
        conn.execute("UPDATE ll_recoveries SET state = 'Cancelled' WHERE recovery_id = ?", (rid,))
    rec = append_record(conn, chain_of(vault_id), now, "checkin",
                        {"vault": vault_id, "from": previous, "cancelled_recoveries": cancelled})
    if previous in ("Vigil", "Handover"):
        for t in _trustees(v):
            notify(conn, APP, t, f"Handover cancelled for {v['name']}",
                   f"The owner checked in. The pending handover is cancelled. Receipt {rec['length']}:{rec['head']}", now)
    return _public(conn, _vault(conn, vault_id), now, user)


# ---------------------------------------------------------------------------
# Online recovery


def open_recovery(conn, now: int, user: str, vault_id: str, public_key: bytes) -> dict:
    v = _vault(conn, vault_id)
    if user not in _trustees(v):
        raise Rejected(404, "not_found")
    v = _observe(conn, v, now)
    if derived_state(v, now) != "Handover":
        raise Rejected(409, "handover_not_started", extra={"state": derived_state(v, now)})
    if conn.execute("SELECT 1 FROM ll_recoveries WHERE vault_id = ? AND state = 'Open'", (vault_id,)).fetchone():
        raise Rejected(409, "recovery_already_open")
    validate_public_key(public_key)
    rid = str(uuid.uuid4())
    fp = fingerprint(public_key)
    conn.execute(
        "INSERT INTO ll_recoveries(recovery_id, vault_id, recoverer_id, public_key, fingerprint, created_at, state)"
        " VALUES (?, ?, ?, ?, ?, ?, 'Open')",
        (rid, vault_id, user, public_key, fp, now),
    )
    rec = append_record(conn, chain_of(vault_id), now, "recovery.opened",
                        {"vault": vault_id, "recovery": rid, "recoverer": user, "fingerprint": fp.hex()})
    for t in _trustees(v):
        if t != user:
            notify(conn, APP, t, f"{user} opened a recovery of {v['name']}",
                   f"Submit your share to recovery {rid[:8]} (key fingerprint {fp.hex()[:32]}). Receipt {rec['length']}:{rec['head']}", now)
    return get_vault(conn, now, user, vault_id)


def _recovery(conn, rid: str):
    r = conn.execute("SELECT * FROM ll_recoveries WHERE recovery_id = ?", (rid,)).fetchone()
    if r is None:
        raise Rejected(404, "not_found")
    return r


def submit_share(conn, now: int, user: str, rid: str, envelope: bytes) -> dict:
    r = _recovery(conn, rid)
    v = _vault(conn, r["vault_id"])
    if user not in _trustees(v):
        raise Rejected(404, "not_found")
    v = _observe(conn, v, now)
    open_now = r["state"] == "Open" and derived_state(v, now) == "Handover"
    # After the package was served the vault stays Released (no check-in can
    # undo that). Other trustees may still add shares to the same recovery, so
    # the recoverer can retry if one contribution does not decrypt.
    supplement = r["state"] == "Complete" and v["released_at"] is not None
    if not (open_now or supplement):
        raise Rejected(409, "recovery_not_open", extra={"state": r["state"]})
    if conn.execute("SELECT 1 FROM ll_recovery_shares WHERE recovery_id = ? AND trustee_id = ?", (rid, user)).fetchone():
        return {"counted": False, "vault": get_vault(conn, now, user, v["vault_id"])}
    check_envelope(envelope)
    conn.execute("INSERT INTO ll_recovery_shares(recovery_id, trustee_id, envelope, created_at) VALUES (?, ?, ?, ?)",
                 (rid, user, envelope, now))
    n = conn.execute("SELECT COUNT(*) AS n FROM ll_recovery_shares WHERE recovery_id = ?", (rid,)).fetchone()["n"]
    append_record(conn, chain_of(v["vault_id"]), now, "recovery.share_submitted",
                  {"vault": v["vault_id"], "recovery": rid, "trustee": user, "count": n})
    if supplement:
        notify(conn, APP, r["recoverer_id"], "Another share was added",
               f"{user} added a share to recovery {rid[:8]}. Retry opening the vault in Last Light.", now)
    elif n >= v["threshold"]:
        notify(conn, APP, r["recoverer_id"], "Recovery ready",
               f"{n} trustees have submitted shares. Open Last Light to fetch the encrypted package and rebuild the vault key in your browser.", now)
    return {"counted": True, "vault": get_vault(conn, now, user, v["vault_id"])}


def _available(earliest: str | None, now: int) -> bool:
    if earliest is None:
        return True
    return datetime.fromtimestamp(now, tz=timezone.utc).date() >= date.fromisoformat(earliest)


def recovery_package(conn, now: int, user: str, rid: str) -> dict:
    """Release to the recovering trustee only, at quorum, after the vigil.
    Items before their earliest release date are withheld online (policy only)."""
    r = conn.execute("SELECT * FROM ll_recoveries WHERE recovery_id = ?", (rid,)).fetchone()
    if r is None or user != r["recoverer_id"]:
        raise Rejected(404, "not_found")
    v = _observe(conn, _vault(conn, r["vault_id"]), now)
    if r["state"] == "Cancelled":
        raise Rejected(410, "cancelled")
    state = derived_state(v, now)
    if r["state"] == "Open" and state != "Handover":
        raise Rejected(409, "handover_not_started", extra={"state": state})
    shares = conn.execute(
        "SELECT trustee_id, envelope FROM ll_recovery_shares WHERE recovery_id = ? ORDER BY created_at, trustee_id", (rid,)
    ).fetchall()
    if len(shares) < v["threshold"]:
        raise Rejected(409, "below_quorum", extra={"submitted": len(shares)})
    items = conn.execute("SELECT * FROM ll_items WHERE vault_id = ? ORDER BY rowid", (v["vault_id"],)).fetchall()
    out_items = []
    for i in items:
        base = {"item_id": i["item_id"], "label": i["label"], "deliver_to": json.loads(i["deliver_to"]),
                "earliest_release": i["earliest_release"]}
        if _available(i["earliest_release"], now):
            base.update(wrapped_key=b64(i["wrapped_key"]), ciphertext=b64(i["ciphertext"]))
        else:
            base["withheld"] = True
        out_items.append(base)
    if r["state"] == "Open":
        conn.execute("UPDATE ll_recoveries SET state = 'Complete' WHERE recovery_id = ?", (rid,))
        conn.execute("UPDATE ll_vaults SET released_at = ?, observed_state = 'Released' WHERE vault_id = ?", (now, v["vault_id"]))
        rec = append_record(conn, chain_of(v["vault_id"]), now, "lantern.released",
                            {"vault": v["vault_id"], "recovery": rid, "recoverer": user})
        for t in [v["owner_id"], *_trustees(v)]:
            notify(conn, APP, t, f"{v['name']} was released",
                   f"The service sent the encrypted recovery package ({len(shares)} trustee shares) to {user}. "
                   f"The vault key is rebuilt and checked in that trustee's browser, not by the service. "
                   f"Receipt {rec['length']}:{rec['head']}", now)
    return {
        "recovery_id": rid,
        "vault_id": v["vault_id"],
        "threshold": v["threshold"],
        "header": b64(v["header"]),
        "envelopes": [{"trustee_id": s["trustee_id"], "envelope": b64(s["envelope"])} for s in shares],
        "items": out_items,
        "receipt": receipt(conn, chain_of(v["vault_id"])),
    }


def bundle(conn, now: int, user: str, vault_id: str) -> dict:
    """The coven/v1 bundle: ciphertext and metadata only, no shares or keys."""
    v = _vault(conn, vault_id)
    if not _member(v, user):
        raise Rejected(404, "not_found")
    _observe(conn, v, now)
    items = conn.execute("SELECT * FROM ll_items WHERE vault_id = ? ORDER BY rowid", (vault_id,)).fetchall()
    append_record(conn, chain_of(vault_id), now, "bundle.exported", {"vault": vault_id, "by": user})
    entries = chain_entries(conn, chain_of(vault_id))
    return {
        "format": "coven/v1",
        "kind": "last-light-vault",
        "exportedAt": iso(now),
        "vault": {"id": vault_id, "name": v["name"], "threshold": v["threshold"],
                  "trustees": [{"id": t, "name": t.split(":", 1)[-1].title()} for t in _trustees(v)]},
        "header": b64(v["header"]),
        "items": [
            {"id": i["item_id"], "label": i["label"], "deliverTo": json.loads(i["deliver_to"]),
             "earliestRelease": i["earliest_release"], "wrappedKey": b64(i["wrapped_key"]), "ciphertext": b64(i["ciphertext"])}
            for i in items
        ],
        "record": {"entries": entries, "receipt": receipt(conn, chain_of(vault_id))},
    }
