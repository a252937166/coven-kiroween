"""Break Glass: seal versions, petitions, approvals and the release decision.

Spec 05 (petition-lifecycle-and-binding). Each function runs inside one
db.tx() transaction and either returns a result or raises Rejected after any
intended state change (for example, marking a petition Expired).
"""

from __future__ import annotations

import json
import sqlite3
import uuid

from .common import (
    Rejected,
    append_record,
    b64,
    check_envelope,
    check_sym_blob,
    fingerprint,
    iso,
    notify,
    receipt,
    validate_public_key,
)

CHAIN = "bg"
APP = "break-glass"
MAX_WINDOW_SECONDS = 3600  # decision D3
MIN_WINDOW_SECONDS = 60
ACTIVE = ("Open", "Approved", "Released")
TERMINAL = ("Expired", "Denied", "Invalidated")

ROTATION_COPY = (
    "This link stops working at {expires_at}. Anything you already copied or downloaded stays "
    "usable after that. The credential stays valid until you rotate it in the system that issued it."
)


def _record(conn, now, type_, **data):
    return append_record(conn, CHAIN, now, type_, data)


def _item(conn: sqlite3.Connection, item_id: str) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM bg_items WHERE item_id = ?", (item_id,)).fetchone()
    if row is None:
        raise Rejected(404, "not_found")
    return row


def _version(conn: sqlite3.Connection, seal_version_id: str) -> sqlite3.Row:
    return conn.execute("SELECT * FROM bg_seal_versions WHERE seal_version_id = ?", (seal_version_id,)).fetchone()


def _approvers(version: sqlite3.Row) -> list[str]:
    return json.loads(version["approver_ids"])


def _petition(conn: sqlite3.Connection, petition_id: str) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM bg_petitions WHERE petition_id = ?", (petition_id,)).fetchone()
    if row is None:
        raise Rejected(404, "not_found")
    return row


def _set_state(conn, petition_id: str, state: str, now: int, **extra) -> None:
    cols = ", ".join(["state = ?"] + [f"{k} = ?" for k in extra])
    params = [state, *extra.values()]
    if state in TERMINAL:
        cols += ", closed_at = ?"
        params.append(now)
    conn.execute(f"UPDATE bg_petitions SET {cols} WHERE petition_id = ?", (*params, petition_id))


def _refresh_expiry(conn, p: sqlite3.Row, now: int) -> sqlite3.Row:
    """Expiry is evaluated at decision time; no background job is needed."""
    if p["state"] in ACTIVE and now >= p["expires_at"]:
        _set_state(conn, p["petition_id"], "Expired", now)
        _record(conn, now, "petition.expired", petition=p["petition_id"])
        return _petition(conn, p["petition_id"])
    return p


def _approval_count(conn, petition_id: str, eligible: list[str]) -> int:
    rows = conn.execute("SELECT approver_id FROM bg_approvals WHERE petition_id = ?", (petition_id,)).fetchall()
    return len({r["approver_id"] for r in rows} & set(eligible))


# ---------------------------------------------------------------------------
# Items and seal versions (BG-02.1, BG-02.3)


def create_item(conn, now: int, admin: str, item_id: str, name: str) -> dict:
    if conn.execute("SELECT 1 FROM bg_items WHERE item_id = ?", (item_id,)).fetchone():
        raise Rejected(409, "item_exists")
    conn.execute(
        "INSERT INTO bg_items(item_id, name, admin_id, created_at) VALUES (?, ?, ?, ?)",
        (item_id, name, admin, now),
    )
    _record(conn, now, "item.created", item=item_id, admin=admin)
    return {"item_id": item_id}


def activate_seal_version(
    conn,
    now: int,
    caller: str,
    item_id: str,
    seal_version_id: str,
    threshold: int,
    approver_ids: list[str],
    header: bytes,
    ciphertext: bytes,
    approver_shares: dict[str, bytes],
) -> dict:
    """Insert an immutable version, make it current and invalidate the old
    version's petitions, all in the caller's transaction (BG-02.3, T-09)."""
    item = _item(conn, item_id)
    if caller != item["admin_id"]:
        raise Rejected(403, "not_item_admin")
    try:
        uuid.UUID(seal_version_id, version=4)
    except ValueError:
        raise Rejected(422, "invalid_seal_version_id") from None
    if conn.execute("SELECT 1 FROM bg_seal_versions WHERE seal_version_id = ?", (seal_version_id,)).fetchone():
        raise Rejected(409, "seal_version_reused")
    if len(set(approver_ids)) != len(approver_ids) or not (2 <= threshold <= len(approver_ids) <= 255):
        raise Rejected(422, "invalid_threshold")
    if set(approver_shares) != set(approver_ids):
        raise Rejected(422, "share_set_mismatch")
    for a in approver_ids:
        if not conn.execute("SELECT 1 FROM enrolled_keys WHERE account_id = ?", (a,)).fetchone():
            raise Rejected(422, "approver_not_enrolled", a)
        check_envelope(approver_shares[a])
    check_sym_blob(header, "header")
    check_sym_blob(ciphertext, "ciphertext")

    conn.execute(
        "INSERT INTO bg_seal_versions(seal_version_id, item_id, threshold, approver_ids, header, ciphertext,"
        " created_at, activated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (seal_version_id, item_id, threshold, json.dumps(approver_ids), header, ciphertext, now, now),
    )
    for a in approver_ids:
        conn.execute(
            "INSERT INTO bg_approver_shares(seal_version_id, approver_id, blob) VALUES (?, ?, ?)",
            (seal_version_id, a, approver_shares[a]),
        )
    previous = item["current_seal_version_id"]
    conn.execute(
        "UPDATE bg_items SET current_seal_version_id = ?, rotation_state = 'none' WHERE item_id = ?",
        (seal_version_id, item_id),
    )
    _record(
        conn, now, "seal.activated", item=item_id, seal_version=seal_version_id,
        previous=previous, threshold=threshold, approvers=approver_ids,
    )
    invalidated = []
    if previous:
        rows = conn.execute(
            "SELECT petition_id FROM bg_petitions WHERE seal_version_id = ? AND state IN (?, ?, ?)",
            (previous, *ACTIVE),
        ).fetchall()
        for r in rows:
            _set_state(conn, r["petition_id"], "Invalidated", now)
            _record(conn, now, "petition.invalidated", petition=r["petition_id"], seal_version=previous)
            invalidated.append(r["petition_id"])
    return {"seal_version_id": seal_version_id, "invalidated_petitions": invalidated}


def list_items(conn) -> list[dict]:
    out = []
    for it in conn.execute("SELECT * FROM bg_items ORDER BY created_at, item_id").fetchall():
        v = _version(conn, it["current_seal_version_id"]) if it["current_seal_version_id"] else None
        out.append(
            {
                "item_id": it["item_id"],
                "name": it["name"],
                "admin_id": it["admin_id"],
                "rotation_state": it["rotation_state"],
                "seal_version_id": it["current_seal_version_id"],
                "threshold": v["threshold"] if v else None,
                "approver_ids": _approvers(v) if v else [],
                "sealed_at": iso(v["activated_at"]) if v else None,
            }
        )
    return out


def _owed_releases(conn, item: sqlite3.Row) -> set[str]:
    """Petitions whose first release opened the item's current rotation obligation.

    Walks the record chain backwards from its head. Releases of the current seal
    version count until the obligation was last closed: a recorded rotation for
    this item, or a new seal version (a reseal clears the obligation). Ordering
    comes from the chain's sequence numbers, not timestamps, so two events in the
    same second keep their order.
    """
    if item["rotation_state"] != "rotation_required":
        return set()
    owed: set[str] = set()
    rows = conn.execute("SELECT type, data FROM records WHERE chain = ? ORDER BY seq DESC", (CHAIN,)).fetchall()
    for r in rows:
        if r["type"] not in ("petition.released", "rotation.confirmed", "seal.activated"):
            continue
        d = json.loads(r["data"])
        if d.get("item") != item["item_id"]:
            continue
        if r["type"] != "petition.released":
            break
        if d.get("seal_version") == item["current_seal_version_id"]:
            owed.add(d["petition"])
    if not owed:
        return owed
    marks = ",".join("?" * len(owed))
    # Cross-check against the petitions table: same item, same current version, really released.
    return {
        x["petition_id"]
        for x in conn.execute(
            f"SELECT petition_id FROM bg_petitions WHERE petition_id IN ({marks}) AND item_id = ? "
            "AND seal_version_id = ? AND first_released_at IS NOT NULL",
            (*owed, item["item_id"], item["current_seal_version_id"]),
        ).fetchall()
    }


def _rotation_parties(conn, item: sqlite3.Row) -> set[str]:
    """Who may record the current rotation: the item admin, and each requester of an owed release."""
    owed = _owed_releases(conn, item)
    parties = {item["admin_id"]}
    if owed:
        marks = ",".join("?" * len(owed))
        parties |= {
            x["requester_id"]
            for x in conn.execute(f"SELECT requester_id FROM bg_petitions WHERE petition_id IN ({marks})", tuple(owed)).fetchall()
        }
    return parties


def confirm_rotation(conn, now: int, caller: str, item_id: str) -> dict:
    """GR-ROT: the item admin, or the requester of a release that made the current
    rotation necessary, confirms it was rotated where it was issued. Anyone else is
    refused before any state or record changes."""
    item = _item(conn, item_id)
    if caller not in _rotation_parties(conn, item):
        raise Rejected(403, "not_rotation_party")
    if item["rotation_state"] != "rotation_required":
        raise Rejected(409, "rotation_not_required")
    conn.execute("UPDATE bg_items SET rotation_state = 'rotated' WHERE item_id = ?", (item_id,))
    _record(conn, now, "rotation.confirmed", item=item_id, by=caller)
    return {"item_id": item_id, "rotation_state": "rotated"}


# ---------------------------------------------------------------------------
# Petitions (BG-02.2, BG-03.1)


def create_petition(
    conn, now: int, requester: str, item_id: str, reason: str, requested_window_seconds: int, public_key: bytes
) -> dict:
    validate_public_key(public_key)
    if not (MIN_WINDOW_SECONDS <= requested_window_seconds):
        raise Rejected(422, "window_too_short", f"window must be at least {MIN_WINDOW_SECONDS} seconds")
    reason = reason.strip()
    if not (1 <= len(reason) <= 500):
        raise Rejected(422, "invalid_reason")
    item = _item(conn, item_id)
    version_id = item["current_seal_version_id"]
    if not version_id:
        raise Rejected(409, "item_not_sealed")
    petition_id = str(uuid.uuid4())
    expires_at = now + min(requested_window_seconds, MAX_WINDOW_SECONDS)
    fp = fingerprint(public_key)
    conn.execute(
        "INSERT INTO bg_petitions(petition_id, item_id, seal_version_id, requester_id, requester_public_key,"
        " fingerprint, reason, created_at, expires_at, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Open')",
        (petition_id, item_id, version_id, requester, public_key, fp, reason, now, expires_at),
    )
    _record(
        conn, now, "petition.opened", petition=petition_id, item=item_id, seal_version=version_id,
        requester=requester, fingerprint=fp.hex(), expires_at=iso(expires_at),
    )
    version = _version(conn, version_id)
    for a in _approvers(version):
        if a != requester:
            notify(
                conn, APP, a, f"Petition for {item['name']}",
                f"{requester} asks for {item['name']}: \"{reason}\". Key fingerprint {fp.hex()[:32]}. "
                f"Open Break Glass to approve or deny before {iso(expires_at)}.", now,
            )
    return status(conn, now, requester, petition_id)


def _visible_to(conn, p: sqlite3.Row, version: sqlite3.Row, user: str) -> bool:
    """Requester, eligible approvers and the item admin may see status."""
    if user == p["requester_id"] or user in _approvers(version):
        return True
    return user == _item(conn, p["item_id"])["admin_id"]


def status(conn, now: int, caller: str, petition_id: str) -> dict:
    """Status only: never ciphertext, header, envelopes or share blobs (BG-01.1)."""
    p = _petition(conn, petition_id)
    version = _version(conn, p["seal_version_id"])
    if not _visible_to(conn, p, version, caller):
        raise Rejected(404, "not_found")
    p = _refresh_expiry(conn, p, now)
    approvers = _approvers(version)
    approved_by = [
        r["approver_id"]
        for r in conn.execute(
            "SELECT approver_id FROM bg_approvals WHERE petition_id = ? ORDER BY created_at, approver_id",
            (petition_id,),
        ).fetchall()
    ]
    item = _item(conn, p["item_id"])
    return {
        "petition_id": p["petition_id"],
        "item_id": p["item_id"],
        "item_name": item["name"],
        "seal_version_id": p["seal_version_id"],
        "seal_version_current": item["current_seal_version_id"] == p["seal_version_id"],
        "requester_id": p["requester_id"],
        "requester_public_key": b64(p["requester_public_key"]),
        "fingerprint": p["fingerprint"].hex(),
        "reason": p["reason"],
        "state": p["state"],
        "threshold": version["threshold"],
        "approvals": _approval_count(conn, petition_id, approvers),
        "approved_by": approved_by,
        "self_approved": p["requester_id"] in approved_by,
        "eligible_approvers": approvers,
        "created_at": iso(p["created_at"]),
        "expires_at": iso(p["expires_at"]),
        "server_now": iso(now),
        "rotation_state": item["rotation_state"],
        # True when this petition's release opened the item's current rotation obligation,
        # so its requester may record the rotation.
        "rotation_owed": p["petition_id"] in _owed_releases(conn, item),
        "retrieval_notice": ROTATION_COPY.format(expires_at=iso(p["expires_at"])),
    }


def list_petitions(conn, now: int, caller: str) -> list[dict]:
    out = []
    for r in conn.execute("SELECT petition_id FROM bg_petitions ORDER BY created_at DESC").fetchall():
        try:
            out.append(status(conn, now, caller, r["petition_id"]))
        except Rejected:
            continue
    return out


def _require_open_for_approver(conn, now: int, caller: str, petition_id: str):
    p = _petition(conn, petition_id)
    version = _version(conn, p["seal_version_id"])
    if caller not in _approvers(version):
        return p, version, False
    p = _refresh_expiry(conn, p, now)
    item = _item(conn, p["item_id"])
    if p["state"] != "Open":
        raise Rejected(409, "petition_not_open", extra={"state": p["state"]})
    if item["current_seal_version_id"] != p["seal_version_id"]:
        raise Rejected(409, "seal_version_superseded")
    return p, version, True


def approver_share(conn, now: int, caller: str, petition_id: str) -> dict:
    """GET /petitions/{id}/approver-share (decision D7). Only the caller's own blob."""
    p, version, eligible = _require_open_for_approver(conn, now, caller, petition_id)
    if not eligible:
        raise Rejected(404, "not_found")
    row = conn.execute(
        "SELECT blob FROM bg_approver_shares WHERE seal_version_id = ? AND approver_id = ?",
        (p["seal_version_id"], caller),
    ).fetchone()
    return {"status": status(conn, now, caller, petition_id), "approver_share": b64(row["blob"])}


def approve(conn, now: int, caller: str, petition_id: str, envelope: bytes) -> dict:
    """Authenticate, check eligibility, count once (BG-03.2, BG-01.4)."""
    p, version, eligible = _require_open_for_approver(conn, now, caller, petition_id)
    if not eligible:
        raise Rejected(403, "not_eligible")
    if conn.execute(
        "SELECT 1 FROM bg_approvals WHERE petition_id = ? AND approver_id = ?", (petition_id, caller)
    ).fetchone():
        return {"counted": False, "status": status(conn, now, caller, petition_id)}
    check_envelope(envelope)
    conn.execute(
        "INSERT INTO bg_approvals(petition_id, approver_id, envelope, created_at) VALUES (?, ?, ?, ?)",
        (petition_id, caller, envelope, now),
    )
    count = _approval_count(conn, petition_id, _approvers(version))
    _record(conn, now, "petition.approved_by", petition=petition_id, approver=caller, count=count)
    if count >= version["threshold"]:
        _set_state(conn, petition_id, "Approved", now)
        _record(conn, now, "petition.quorum", petition=petition_id, count=count)
        notify(
            conn, APP, p["requester_id"], "Petition approved",
            f"Your petition {petition_id[:8]} reached quorum. Retrieve it before {iso(p['expires_at'])}.", now,
        )
    return {"counted": True, "status": status(conn, now, caller, petition_id)}


def deny(conn, now: int, caller: str, petition_id: str) -> dict:
    """Decision D2: an eligible approver or the item admin. Terminal."""
    p = _petition(conn, petition_id)
    version = _version(conn, p["seal_version_id"])
    item = _item(conn, p["item_id"])
    if caller not in _approvers(version) and caller != item["admin_id"]:
        raise Rejected(404, "not_found")
    p = _refresh_expiry(conn, p, now)
    if p["state"] not in ("Open", "Approved"):
        raise Rejected(409, "petition_not_deniable", extra={"state": p["state"]})
    _set_state(conn, petition_id, "Denied", now)
    _record(conn, now, "petition.denied", petition=petition_id, by=caller)
    notify(conn, APP, p["requester_id"], "Petition denied", f"Petition {petition_id[:8]} was denied by {caller}.", now)
    return {"state": "Denied"}


# ---------------------------------------------------------------------------
# Release decision (BG-01.1, BG-01.2, BG-01.3)


def release(conn, now: int, caller: str, petition_id: str) -> dict:
    """One decision in one transaction. Material is read only after every check passes."""
    p = conn.execute("SELECT * FROM bg_petitions WHERE petition_id = ?", (petition_id,)).fetchone()
    if p is None or caller != p["requester_id"]:
        raise Rejected(404, "not_found")
    p = _refresh_expiry(conn, p, now)
    if p["state"] == "Expired" or now >= p["expires_at"]:
        raise Rejected(410, "expired", extra={"state": p["state"]})
    if p["state"] in ("Denied", "Invalidated"):
        raise Rejected(410, p["state"].lower(), extra={"state": p["state"]})
    item = _item(conn, p["item_id"])
    if item["current_seal_version_id"] != p["seal_version_id"]:
        raise Rejected(410, "invalidated", extra={"state": p["state"]})
    version = _version(conn, p["seal_version_id"])
    eligible = _approvers(version)
    count = _approval_count(conn, petition_id, eligible)
    if p["state"] not in ("Approved", "Released") or count < version["threshold"]:
        raise Rejected(409, "below_quorum", extra={"state": p["state"], "approvals": count})

    rows = conn.execute(
        "SELECT approver_id, envelope FROM bg_approvals WHERE petition_id = ? ORDER BY created_at, approver_id",
        (petition_id,),
    ).fetchall()
    envelopes = [{"approver_id": r["approver_id"], "envelope": b64(r["envelope"])} for r in rows if r["approver_id"] in eligible]
    envelopes = envelopes[: version["threshold"]]
    if p["state"] == "Approved":
        _set_state(conn, petition_id, "Released", now, first_released_at=now)
        conn.execute("UPDATE bg_items SET rotation_state = 'rotation_required' WHERE item_id = ?", (p["item_id"],))
        _record(conn, now, "petition.released", petition=petition_id, item=p["item_id"], seal_version=p["seal_version_id"])
        _record(conn, now, "rotation.required", item=p["item_id"])
    else:
        _record(conn, now, "petition.retrieved_again", petition=petition_id)
    return {
        "petition_id": petition_id,
        "item_id": p["item_id"],
        "seal_version_id": p["seal_version_id"],
        "threshold": version["threshold"],
        "item_header": b64(version["header"]),
        "item_ciphertext": b64(version["ciphertext"]),
        "envelopes": envelopes,
        "expires_at": iso(p["expires_at"]),
        "retrieval_notice": ROTATION_COPY.format(expires_at=iso(p["expires_at"])),
        "receipt": receipt(conn, CHAIN),
    }
