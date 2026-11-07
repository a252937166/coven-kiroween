"""SQLite storage. Holds workflow metadata and opaque ciphertext only.

The service never stores plaintext, private keys, symmetric keys or raw shares.
Write-once columns are enforced by triggers (spec 05 design section 2, T-08).
"""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from typing import Iterator

SCHEMA = """
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS enrolled_keys (
  account_id TEXT PRIMARY KEY, public_key BLOB NOT NULL, enrolled_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS records (
  chain TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL, type TEXT NOT NULL,
  data TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (chain, seq));

CREATE TABLE IF NOT EXISTS mail (
  id INTEGER PRIMARY KEY AUTOINCREMENT, app TEXT NOT NULL, to_user TEXT NOT NULL,
  subject TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL);

-- Break Glass --------------------------------------------------------------

CREATE TABLE IF NOT EXISTS bg_items (
  item_id TEXT PRIMARY KEY, name TEXT NOT NULL, admin_id TEXT NOT NULL,
  current_seal_version_id TEXT, rotation_state TEXT NOT NULL DEFAULT 'none',
  created_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS bg_seal_versions (
  seal_version_id TEXT PRIMARY KEY, item_id TEXT NOT NULL, threshold INTEGER NOT NULL,
  approver_ids TEXT NOT NULL, header BLOB NOT NULL, ciphertext BLOB NOT NULL,
  created_at INTEGER NOT NULL, activated_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS bg_approver_shares (
  seal_version_id TEXT NOT NULL, approver_id TEXT NOT NULL, blob BLOB NOT NULL,
  PRIMARY KEY (seal_version_id, approver_id));

CREATE TABLE IF NOT EXISTS bg_petitions (
  petition_id TEXT PRIMARY KEY, item_id TEXT NOT NULL, seal_version_id TEXT NOT NULL,
  requester_id TEXT NOT NULL, requester_public_key BLOB NOT NULL, fingerprint BLOB NOT NULL,
  reason TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  state TEXT NOT NULL, first_released_at INTEGER, closed_at INTEGER);

CREATE TABLE IF NOT EXISTS bg_approvals (
  petition_id TEXT NOT NULL, approver_id TEXT NOT NULL, envelope BLOB NOT NULL,
  created_at INTEGER NOT NULL, PRIMARY KEY (petition_id, approver_id));

CREATE TRIGGER IF NOT EXISTS bg_seal_versions_immutable BEFORE UPDATE ON bg_seal_versions
BEGIN SELECT RAISE(ABORT, 'seal versions are immutable'); END;

CREATE TRIGGER IF NOT EXISTS bg_approver_shares_immutable BEFORE UPDATE ON bg_approver_shares
BEGIN SELECT RAISE(ABORT, 'approver shares are immutable'); END;

CREATE TRIGGER IF NOT EXISTS bg_approvals_immutable BEFORE UPDATE ON bg_approvals
BEGIN SELECT RAISE(ABORT, 'approvals are immutable'); END;

CREATE TRIGGER IF NOT EXISTS bg_petitions_write_once
BEFORE UPDATE OF petition_id, item_id, seal_version_id, requester_id,
  requester_public_key, fingerprint, reason, created_at, expires_at ON bg_petitions
BEGIN SELECT RAISE(ABORT, 'petition bindings are write-once'); END;

-- Last Light ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ll_vaults (
  vault_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL,
  threshold INTEGER NOT NULL, trustee_ids TEXT NOT NULL, header BLOB NOT NULL,
  owner_key_blob BLOB NOT NULL,
  cadence_seconds INTEGER NOT NULL, flicker_seconds INTEGER NOT NULL, vigil_seconds INTEGER NOT NULL,
  last_checkin_at INTEGER NOT NULL, observed_state TEXT NOT NULL, released_at INTEGER,
  created_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS ll_trustee_shares (
  vault_id TEXT NOT NULL, trustee_id TEXT NOT NULL, blob BLOB NOT NULL,
  PRIMARY KEY (vault_id, trustee_id));

CREATE TABLE IF NOT EXISTS ll_items (
  vault_id TEXT NOT NULL, item_id TEXT NOT NULL, label TEXT NOT NULL, deliver_to TEXT NOT NULL,
  earliest_release TEXT, wrapped_key BLOB NOT NULL, ciphertext BLOB NOT NULL,
  created_at INTEGER NOT NULL, PRIMARY KEY (vault_id, item_id));

CREATE TABLE IF NOT EXISTS ll_recoveries (
  recovery_id TEXT PRIMARY KEY, vault_id TEXT NOT NULL, recoverer_id TEXT NOT NULL,
  public_key BLOB NOT NULL, fingerprint BLOB NOT NULL, created_at INTEGER NOT NULL,
  state TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS ll_recovery_shares (
  recovery_id TEXT NOT NULL, trustee_id TEXT NOT NULL, envelope BLOB NOT NULL,
  created_at INTEGER NOT NULL, PRIMARY KEY (recovery_id, trustee_id));

CREATE TRIGGER IF NOT EXISTS ll_recoveries_write_once
BEFORE UPDATE OF recovery_id, vault_id, recoverer_id, public_key, fingerprint, created_at ON ll_recoveries
BEGIN SELECT RAISE(ABORT, 'recovery bindings are write-once'); END;
"""


def connect(path: str) -> sqlite3.Connection:
    # One connection per request. FastAPI may run that request's dependencies on
    # different worker threads, one after another, so allow cross-thread use.
    conn = sqlite3.connect(path, isolation_level=None, timeout=10, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 10000")
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init(path: str) -> None:
    conn = connect(path)
    try:
        conn.executescript(SCHEMA)
    finally:
        conn.close()


@contextmanager
def tx(conn: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    """One write transaction. BEGIN IMMEDIATE takes the database write lock,
    which serializes concurrent decisions the way row locks would."""
    from .common import Rejected  # local import avoids a cycle

    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
    except Rejected:
        # Domain code raises Rejected only after the state changes it intends
        # to keep (for example, marking a petition Expired), so commit them.
        conn.execute("COMMIT")
        raise
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    else:
        conn.execute("COMMIT")
