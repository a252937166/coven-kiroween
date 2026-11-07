"""Shared pieces: clock, records chain, mail, validation, results."""

from __future__ import annotations

import base64
import hashlib
import json
import sqlite3
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from cryptography.hazmat.primitives.asymmetric import ec

# ---------------------------------------------------------------------------
# Clock. Only the server clock decides expiry and lantern state. Demo mode may
# move it forward through a labelled control; it never moves backward.


class Clock:
    def __init__(self, base=time.time):
        self._base = base

    def offset(self, conn: sqlite3.Connection) -> int:
        row = conn.execute("SELECT value FROM settings WHERE key = 'clock_offset'").fetchone()
        return int(row["value"]) if row else 0

    def now(self, conn: sqlite3.Connection) -> int:
        return int(self._base()) + self.offset(conn)

    def advance(self, conn: sqlite3.Connection, seconds: int) -> int:
        if seconds <= 0:
            raise ValueError("the demo clock only moves forward")
        new = self.offset(conn) + seconds
        conn.execute(
            "INSERT INTO settings(key, value) VALUES('clock_offset', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (str(new),),
        )
        return new


def iso(ts: int | None) -> str | None:
    if ts is None:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# Records: append-only hash chain per scope. Hashing matches core-ts/src/records.ts.

GENESIS = "0" * 64


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def entry_hash(prev: str, seq: int, at: str, type_: str, data: dict) -> str:
    body = canonical_json({"seq": seq, "at": at, "type": type_, "data": data})
    return hashlib.sha256(f"coven/v1/record\n{prev}\n{body}".encode()).hexdigest()


def append_record(conn: sqlite3.Connection, chain: str, now: int, type_: str, data: dict) -> dict:
    for v in data.values():
        if isinstance(v, (bytes, bytearray)):
            raise TypeError("records never carry binary material")
    row = conn.execute(
        "SELECT seq, hash FROM records WHERE chain = ? ORDER BY seq DESC LIMIT 1", (chain,)
    ).fetchone()
    seq = (row["seq"] if row else 0) + 1
    prev = row["hash"] if row else GENESIS
    at = iso(now)
    h = entry_hash(prev, seq, at, type_, data)
    conn.execute(
        "INSERT INTO records(chain, seq, at, type, data, hash) VALUES (?, ?, ?, ?, ?, ?)",
        (chain, seq, at, type_, canonical_json(data), h),
    )
    return {"length": seq, "head": h}


def chain_entries(conn: sqlite3.Connection, chain: str) -> list[dict]:
    rows = conn.execute(
        "SELECT seq, at, type, data, hash FROM records WHERE chain = ? ORDER BY seq", (chain,)
    ).fetchall()
    return [
        {"seq": r["seq"], "at": r["at"], "type": r["type"], "data": json.loads(r["data"]), "hash": r["hash"]}
        for r in rows
    ]


def receipt(conn: sqlite3.Connection, chain: str) -> dict:
    row = conn.execute(
        "SELECT seq, hash FROM records WHERE chain = ? ORDER BY seq DESC LIMIT 1", (chain,)
    ).fetchone()
    return {"length": row["seq"], "head": row["hash"]} if row else {"length": 0, "head": GENESIS}


def verify_receipt(entries: list[dict], rec: dict) -> str:
    """Exactly one of consistent, altered, truncated (proposal section 3.4)."""
    if len(entries) < rec["length"]:
        return "truncated"
    h = GENESIS
    for e in entries[: rec["length"]]:
        h = entry_hash(h, e["seq"], e["at"], e["type"], e["data"])
    return "consistent" if h == rec["head"] else "altered"


# ---------------------------------------------------------------------------
# Demo mail viewer. Notifications never carry shares, keys or ciphertext.


def notify(conn: sqlite3.Connection, app: str, to_user: str, subject: str, body: str, now: int) -> None:
    conn.execute(
        "INSERT INTO mail(app, to_user, subject, body, at) VALUES (?, ?, ?, ?, ?)",
        (app, to_user, subject, body, now),
    )


# ---------------------------------------------------------------------------
# Validation at the trust boundary.

P256_RAW_LEN = 65
NONCE_LEN = 12
TAG_LEN = 16
MAX_SHARE_PLAINTEXT = 4096
MAX_BLOB = 64 * 1024


class Rejected(Exception):
    """A refused request. Raised only after any intended state change is written."""

    def __init__(self, status: int, code: str, detail: str = "", extra: dict | None = None):
        super().__init__(code)
        self.status = status
        self.code = code
        self.detail = detail
        self.extra = extra or {}


def b64decode(value: str, what: str) -> bytes:
    try:
        return base64.b64decode(value, validate=True)
    except Exception:
        raise Rejected(422, "invalid_base64", f"{what} is not valid base64") from None


def b64(value: bytes) -> str:
    return base64.b64encode(value).decode()


def validate_public_key(raw: bytes) -> bytes:
    """65-byte uncompressed P-256 point on the curve (BG-03.1, T-10)."""
    if len(raw) != P256_RAW_LEN or raw[0] != 0x04:
        raise Rejected(422, "invalid_public_key", "public key must be a 65-byte uncompressed P-256 point")
    try:
        ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), raw)
    except ValueError:
        raise Rejected(422, "invalid_public_key", "public key is not a valid P-256 point") from None
    return raw


def fingerprint(raw: bytes) -> bytes:
    return hashlib.sha256(raw).digest()


def is_well_formed_envelope(env: bytes) -> bool:
    header = 1 + P256_RAW_LEN + NONCE_LEN
    return (
        header + TAG_LEN < len(env) <= header + TAG_LEN + MAX_SHARE_PLAINTEXT
        and env[0] == 0x01
        and env[1] == 0x04
    )


def check_envelope(env: bytes) -> bytes:
    if not is_well_formed_envelope(env):
        raise Rejected(422, "malformed_envelope", "envelope is not well formed")
    return env


def check_sym_blob(blob: bytes, what: str) -> bytes:
    if not (1 + NONCE_LEN + TAG_LEN <= len(blob) <= MAX_BLOB and blob[0] == 0x02):
        raise Rejected(422, "malformed_ciphertext", f"{what} is not well formed")
    return blob


@dataclass
class Ctx:
    conn: sqlite3.Connection
    clock: Clock
    user: str
    now: int = 0
    extra: dict = field(default_factory=dict)
