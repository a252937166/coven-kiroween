"""Private demo spaces for a hosted deployment.

Shared mode (the local default) keeps one SQLite file for everyone, exactly as
before. Hosted mode (--spaces-dir) gives every browser its own private space
for each app. A space is a separate SQLite file that holds all of that
browser's demo data: sessions, enrolled keys, items, petitions, vaults,
records, demo mail and the demo clock. One judge's setup, persona switches,
clock moves and resets therefore never reach another judge's space.

A space is named by a random token that only the service issues, returned in
a host-only cookie (the __Host- prefix requires Secure, Path=/ and no Domain).
Only the token's SHA-256 is stored, and it is also the file name, so neither
the directory nor the registry can be turned back into a cookie. Spaces are
logged only as counts.

Bounds for a small server, all on wall-clock time (moving a demo clock never
ages or protects a space):
  - each space file holds at most `max_bytes`; a write beyond it is refused
    (507), and Reset demo frees the space;
  - a space unused for `idle_seconds` is deleted;
  - at most `max_spaces` spaces exist; when full, the least recently used
    space idle for at least `min_idle_seconds` makes room, else sign-in is
    refused (503);
  - at most `per_client` spaces per client address; over it, that address's
    own least recently used idle space makes room, else 429. Addresses are
    kept only as a keyed hash whose key lives in memory and changes at every
    start.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
import re
import secrets
import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from fastapi import Request
from starlette.responses import Response

from . import db
from .common import Rejected

log = logging.getLogger("coven.spaces")

SLUG = {"last-light": "ll", "break-glass": "bg"}
_TOKEN = re.compile(r"[A-Za-z0-9_-]{43}")  # secrets.token_urlsafe(32)
_SPACE_FILE = re.compile(r"([0-9a-f]{64})\.sqlite(-journal|-wal|-shm)?")

REGISTRY_SCHEMA = """
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS spaces (
  space_id TEXT PRIMARY KEY, app TEXT NOT NULL, client_tag TEXT NOT NULL,
  created_at INTEGER NOT NULL, last_used INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS spaces_by_last_used ON spaces(last_used);
CREATE INDEX IF NOT EXISTS spaces_by_client ON spaces(client_tag, last_used);
"""


@dataclass(frozen=True)
class SpaceConfig:
    dir: str
    max_spaces: int = 200
    idle_seconds: int = 7 * 86400
    min_idle_seconds: int = 30 * 60
    max_bytes: int = 2 * 1024 * 1024
    per_client: int = 24
    secure_cookies: bool = True

    @classmethod
    def from_env(cls) -> SpaceConfig | None:
        """Hosted mode when COVEN_SPACES_DIR is set (python -m coven_service sets it from --spaces-dir)."""
        e = os.environ
        if not e.get("COVEN_SPACES_DIR"):
            return None
        return cls(
            dir=e["COVEN_SPACES_DIR"],
            max_spaces=int(e.get("COVEN_SPACES_MAX", cls.max_spaces)),
            idle_seconds=int(float(e.get("COVEN_SPACE_IDLE_HOURS", cls.idle_seconds / 3600)) * 3600),
            min_idle_seconds=int(float(e.get("COVEN_SPACE_MIN_IDLE_MINUTES", cls.min_idle_seconds / 60)) * 60),
            max_bytes=int(float(e.get("COVEN_SPACE_MAX_MB", cls.max_bytes / 1048576)) * 1048576),
            per_client=int(e.get("COVEN_SPACES_PER_CLIENT", cls.per_client)),
            secure_cookies=e.get("COVEN_INSECURE_COOKIES", "") != "1",
        )


@dataclass(frozen=True)
class Space:
    space_id: str
    token: str
    app: str
    path: str


class Spaces:
    TOUCH_EVERY = 60  # seconds between last-used updates of one space
    SWEEP_EVERY = 60  # seconds between idle sweeps
    STRAY_AGE = 3600  # a space file with no registry row is removed after this long

    def __init__(self, cfg: SpaceConfig, wall: Callable[[], float] = time.time):
        if cfg.max_spaces < 1 or cfg.per_client < 1 or cfg.idle_seconds < 60:
            raise ValueError("space limits must allow at least one space for a minute")
        self.cfg = cfg
        self.wall = wall
        self.dir = Path(cfg.dir).resolve()
        self.dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.registry_path = str(self.dir / "registry.sqlite")
        c = db.connect(self.registry_path)
        try:
            c.executescript(REGISTRY_SCHEMA)
        finally:
            c.close()
        self.max_pages = max(1, cfg.max_bytes // db.SPACE_PAGE_SIZE)
        self._tag_key = secrets.token_bytes(32)  # memory only: client tags never outlive the process
        self._sweep_lock = threading.Lock()
        self._last_sweep = float("-inf")
        self.sweep()

    # -- cookies ---------------------------------------------------------------

    def _prefix(self) -> str:
        return "__Host-" if self.cfg.secure_cookies else ""

    def space_cookie(self, app: str) -> str:
        return f"{self._prefix()}coven_space_{SLUG[app]}"

    def session_cookie(self, app: str) -> str:
        return f"{self._prefix()}coven_session_{SLUG[app]}"

    def app_of(self, request: Request) -> str | None:
        """Each app sends X-Coven-App. A space belongs to one app."""
        app = request.headers.get("x-coven-app", "")
        return app if app in SLUG else None

    def _set(self, response: Response, name: str, value: str) -> None:
        response.set_cookie(
            name, value, max_age=self.cfg.idle_seconds, path="/",
            secure=self.cfg.secure_cookies, httponly=True, samesite="strict",
        )

    def keep(self, response: Response, space: Space, session: str | None = None) -> None:
        """Set or refresh the space cookie (and the session cookie, when given) for the idle lifetime."""
        self._set(response, self.space_cookie(space.app), space.token)
        if session:
            self._set(response, self.session_cookie(space.app), session)

    def end_session(self, response: Response, app: str) -> None:
        response.delete_cookie(
            self.session_cookie(app), path="/", secure=self.cfg.secure_cookies, httponly=True, samesite="strict",
        )

    # -- spaces ----------------------------------------------------------------

    def _file(self, space_id: str) -> str:
        return str(self.dir / f"{space_id}.sqlite")

    def _unlink(self, space_id: str) -> None:
        for suffix in ("", "-journal", "-wal", "-shm"):
            try:
                os.remove(self._file(space_id) + suffix)
            except FileNotFoundError:
                pass

    def _remove(self, space_ids: list[str]) -> None:
        if not space_ids:
            return
        c = db.connect(self.registry_path)
        try:
            with db.tx(c):
                for sid in space_ids:
                    c.execute("DELETE FROM spaces WHERE space_id = ?", (sid,))
        finally:
            c.close()
        for sid in space_ids:
            self._unlink(sid)

    def resolve(self, request: Request) -> Space | None:
        """The caller's space for the app it names, or None. Marks it used."""
        app = self.app_of(request)
        if app is None:
            return None
        token = request.cookies.get(self.space_cookie(app), "")
        if not _TOKEN.fullmatch(token):
            return None
        sid = hashlib.sha256(token.encode()).hexdigest()
        now = int(self.wall())
        expired = False
        c = db.connect(self.registry_path)
        try:
            row = c.execute("SELECT app, last_used FROM spaces WHERE space_id = ?", (sid,)).fetchone()
            if row is None or row["app"] != app:
                return None
            if now - row["last_used"] > self.cfg.idle_seconds:
                expired = True  # the same rule as the sweep, applied without waiting for it
            elif now - row["last_used"] >= self.TOUCH_EVERY:
                c.execute("UPDATE spaces SET last_used = ? WHERE space_id = ? AND last_used < ?", (now, sid, now))
        finally:
            c.close()
        if expired or not os.path.exists(self._file(sid)):
            self._remove([sid])
            return None
        self.maybe_sweep()
        return Space(sid, token, app, self._file(sid))

    def connect(self, space: Space) -> sqlite3.Connection:
        """A connection to an existing space, size-capped. It never creates a file."""
        try:
            c = db.connect(Path(space.path).as_uri() + "?mode=rw", uri=True)
        except sqlite3.OperationalError:
            raise Rejected(401, "not_signed_in") from None  # removed meanwhile
        c.execute(f"PRAGMA max_page_count = {self.max_pages}")
        return c

    def _client_tag(self, request: Request) -> str:
        host = request.client.host if request.client else ""
        return hmac.new(self._tag_key, host.encode(), hashlib.sha256).hexdigest()[:32]

    def create(self, request: Request, app: str) -> Space:
        """A new space for this browser and app, within the bounds in the module docstring."""
        self.maybe_sweep()
        now = int(self.wall())
        idle_since = now - self.cfg.min_idle_seconds
        tag = self._client_tag(request)
        token = secrets.token_urlsafe(32)
        sid = hashlib.sha256(token.encode()).hexdigest()
        db.init_space(self._file(sid))  # a file whose registry row never lands is removed by the sweep
        victims: list[str] = []
        c = db.connect(self.registry_path)
        try:
            with db.tx(c):
                mine = c.execute("SELECT count(*) FROM spaces WHERE client_tag = ?", (tag,)).fetchone()[0]
                if mine >= self.cfg.per_client:
                    row = c.execute(
                        "SELECT space_id FROM spaces WHERE client_tag = ? AND last_used <= ? ORDER BY last_used LIMIT 1",
                        (tag, idle_since),
                    ).fetchone()
                    if row is None:
                        raise Rejected(429, "too_many_demo_spaces",
                                       "This network opened many demo spaces in a short time. Try again in a few minutes.")
                    victims.append(row["space_id"])
                live = c.execute("SELECT count(*) FROM spaces").fetchone()[0] - len(victims)
                if live >= self.cfg.max_spaces:
                    row = c.execute(
                        "SELECT space_id FROM spaces WHERE last_used <= ? AND space_id != ? ORDER BY last_used LIMIT 1",
                        (idle_since, victims[0] if victims else ""),
                    ).fetchone()
                    if row is None:
                        raise Rejected(503, "demo_busy", "All demo spaces are in use. Try again in a few minutes.")
                    victims.append(row["space_id"])
                for v in victims:
                    c.execute("DELETE FROM spaces WHERE space_id = ?", (v,))
                c.execute(
                    "INSERT INTO spaces(space_id, app, client_tag, created_at, last_used) VALUES (?, ?, ?, ?, ?)",
                    (sid, app, tag, now, now),
                )
                live_after = c.execute("SELECT count(*) FROM spaces").fetchone()[0]
        except Rejected:
            self._unlink(sid)
            raise
        finally:
            c.close()
        for v in victims:
            self._unlink(v)
        log.info("space created live=%d made_room=%d", live_after, len(victims))
        return Space(sid, token, app, self._file(sid))

    def maybe_sweep(self) -> None:
        now = time.monotonic()
        if now - self._last_sweep < self.SWEEP_EVERY or not self._sweep_lock.acquire(blocking=False):
            return
        try:
            self._last_sweep = now
            self.sweep()
        finally:
            self._sweep_lock.release()

    def sweep(self) -> int:
        """Delete spaces unused for longer than the idle limit, and stray space files."""
        cutoff = int(self.wall()) - self.cfg.idle_seconds
        c = db.connect(self.registry_path)
        try:
            with db.tx(c):
                gone = [r["space_id"] for r in c.execute("SELECT space_id FROM spaces WHERE last_used < ?", (cutoff,))]
                c.execute("DELETE FROM spaces WHERE last_used < ?", (cutoff,))
            known = {r["space_id"] for r in c.execute("SELECT space_id FROM spaces")}
        finally:
            c.close()
        for sid in gone:
            self._unlink(sid)
        stray = 0
        for f in self.dir.iterdir():
            m = _SPACE_FILE.fullmatch(f.name)
            if m is None or m.group(1) in known:
                continue
            try:
                if time.time() - f.stat().st_mtime > self.STRAY_AGE:  # file age is real time, never the demo clock
                    f.unlink()
                    stray += 1
            except FileNotFoundError:
                pass
        if gone or stray:
            log.info("spaces swept idle=%d stray_files=%d live=%d", len(gone), stray, len(known))
        return len(gone)

    def count(self) -> int:
        c = db.connect(self.registry_path)
        try:
            return c.execute("SELECT count(*) FROM spaces").fetchone()[0]
        finally:
            c.close()
