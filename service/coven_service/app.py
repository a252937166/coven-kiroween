"""FastAPI service for both demo apps. Binds to 127.0.0.1 only.

Demo sign-in: one judge can play every fictional persona. The service still
authenticates each request by session cookie and binds identities and public
keys itself (the MVP trust model in guarantees.md).

Two storage modes. Shared (local default): one SQLite file for everyone.
Hosted (`spaces`): every browser gets a private demo space per app, so judges
never see or change each other's data or demo clock (see spaces.py).
"""

from __future__ import annotations

import logging
import os
import secrets
import sqlite3
import time
from typing import Any, Callable

from fastapi import Depends, FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from . import db, lastlight, petitions
from .common import Clock, Rejected, b64, b64decode, chain_entries, check_envelope, iso, receipt, validate_public_key
from .spaces import SpaceConfig, Spaces

log = logging.getLogger("coven.access")

PERSONAS: dict[str, dict[str, str]] = {
    # Break Glass (fictional team)
    "user:quinn": {"name": "Quinn", "app": "break-glass", "role": "Item admin"},
    "user:sage": {"name": "Sage", "app": "break-glass", "role": "Approver"},
    "user:rowan": {"name": "Rowan", "app": "break-glass", "role": "Approver"},
    "user:ash": {"name": "Ash", "app": "break-glass", "role": "Approver"},
    "user:wren": {"name": "Wren", "app": "break-glass", "role": "Approver"},
    "user:robin": {"name": "Robin", "app": "break-glass", "role": "On-call engineer"},
    "user:kit": {"name": "Kit", "app": "break-glass", "role": "Engineer"},
    # Last Light (fictional family)
    "user:mara": {"name": "Mara Hollow", "app": "last-light", "role": "Vault owner"},
    "user:ada": {"name": "Ada", "app": "last-light", "role": "Trustee"},
    "user:bram": {"name": "Bram", "app": "last-light", "role": "Trustee"},
    "user:cleo": {"name": "Cleo", "app": "last-light", "role": "Trustee"},
    "user:dov": {"name": "Dov", "app": "last-light", "role": "Trustee"},
    "user:esme": {"name": "Esme", "app": "last-light", "role": "Trustee"},
}

COOKIE = "coven_session"
APPS = {"break-glass": "coven_session_bg", "last-light": "coven_session_ll"}


def cookie_name(request: Request) -> str:
    """Browsers share cookies across localhost ports, so each app sends
    X-Coven-App and gets its own session cookie."""
    return APPS.get(request.headers.get("x-coven-app", ""), COOKIE)


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SessionIn(Strict):
    user: str


class EnrollIn(Strict):
    public_key: str


class ItemIn(Strict):
    item_id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{1,63}$")
    name: str = Field(min_length=1, max_length=120)


class SealIn(Strict):
    seal_version_id: str
    threshold: int
    approver_ids: list[str]
    header: str
    ciphertext: str
    approver_shares: dict[str, str]


class PetitionIn(Strict):
    """No requester field: the requester is the authenticated session (BG-03.1)."""

    item_id: str
    reason: str
    requested_window_seconds: int = 900
    requester_public_key: str


class EnvelopeIn(Strict):
    envelope: str


class VaultIn(Strict):
    vault_id: str
    name: str = Field(min_length=1, max_length=120)
    threshold: int
    trustee_ids: list[str]
    header: str
    owner_key_blob: str
    trustee_shares: dict[str, str]
    cadence_days: int = 30
    vigil_days: int = 14
    flicker_days: int = 3


class VaultItemIn(Strict):
    item_id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{1,63}$")
    label: str = Field(min_length=1, max_length=120)
    deliver_to: list[str] = []
    earliest_release: str | None = None
    wrapped_key: str
    ciphertext: str


class RecoveryIn(Strict):
    public_key: str


class ClockIn(Strict):
    advance_seconds: int = Field(gt=0, le=400 * 86400)


# Log only these fields per request. Bodies, query strings and headers are never logged (GR-LOG).
LOGGED_FIELDS = ("method", "route", "status", "user", "ms")

# Hosted mode: the largest real request (a seal with four approver shares) is about 200 KB.
MAX_BODY = 512 * 1024


def create_app(db_path: str | None, clock: Clock | None = None, demo: bool = True, spaces: SpaceConfig | None = None) -> FastAPI:
    clock = clock or Clock()
    hosted = Spaces(spaces, wall=clock.wall) if spaces is not None else None
    if hosted is None:
        if not db_path:
            raise ValueError("shared mode needs a database path")
        db.init(db_path)
    app = FastAPI(title="Coven service", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.spaces = hosted

    def too_large(request: Request) -> bool:
        n = request.headers.get("content-length")
        return n is not None and (not n.isdigit() or int(n) > MAX_BODY)

    @app.middleware("http")
    async def access_log(request: Request, call_next):
        start = time.perf_counter()
        if hosted is not None and too_large(request):
            response = JSONResponse({"error": "request_too_large"}, status_code=413)
        else:
            response = await call_next(request)
        route = request.scope.get("route")
        fields = {
            "method": request.method,
            "route": getattr(route, "path", "unmatched"),
            "status": response.status_code,
            "user": getattr(request.state, "user", "-"),
            "ms": int((time.perf_counter() - start) * 1000),
        }
        log.info(" ".join(f"{k}={fields[k]}" for k in LOGGED_FIELDS))
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        return response

    @app.exception_handler(Rejected)
    async def rejected(_: Request, e: Rejected):
        body: dict[str, Any] = {"error": e.code}
        if e.detail:
            body["detail"] = e.detail
        body.update(e.extra)
        return JSONResponse(body, status_code=e.status)

    @app.exception_handler(RequestValidationError)
    async def invalid(_: Request, e: RequestValidationError):
        # Never echo submitted values (FastAPI's default includes "input").
        errors = [{"loc": list(err.get("loc", [])), "type": err.get("type")} for err in e.errors()]
        return JSONResponse({"error": "invalid_request", "fields": errors}, status_code=422)

    if hosted is not None:

        @app.exception_handler(sqlite3.OperationalError)
        async def storage(_: Request, e: sqlite3.OperationalError):
            # A space is size-capped: the write was refused and rolled back, earlier data stays.
            if "database or disk is full" in str(e):
                return JSONResponse(
                    {"error": "demo_space_full", "detail": "This demo space is full. Use Reset demo to start again."},
                    status_code=507,
                )
            log.warning("storage error: %s", e)  # SQLite messages name tables, never values
            return JSONResponse({"error": "storage_error"}, status_code=500)

    def session_cookie(request: Request) -> str | None:
        if hosted is None:
            return cookie_name(request)
        app_name = hosted.app_of(request)
        return hosted.session_cookie(app_name) if app_name else None

    def open_db(request: Request) -> sqlite3.Connection:
        """Shared mode: the one database. Hosted: the caller's own space, or 401 when it has none."""
        if hosted is None:
            return db.connect(db_path)
        space = hosted.resolve(request)
        if space is None:
            raise Rejected(401, "not_signed_in")
        request.state.space = space
        return hosted.connect(space)

    def conn(request: Request):
        c = open_db(request)
        try:
            yield c
        finally:
            c.close()

    def user(request: Request, c=Depends(conn)) -> str:
        name = session_cookie(request)
        token = request.cookies.get(name) if name else None
        row = c.execute("SELECT user_id FROM sessions WHERE token = ?", (token or "",)).fetchone()
        if row is None:
            raise Rejected(401, "not_signed_in")
        request.state.user = row["user_id"]
        return row["user_id"]

    def run(c, fn: Callable, *args):
        with db.tx(c):
            return fn(c, clock.now(c), *args)

    # -- session and directory ------------------------------------------------

    @app.get("/api/personas")
    def personas():
        return [{"id": k, **v} for k, v in PERSONAS.items()]

    if demo:

        @app.post("/api/session")
        def sign_in(body: SessionIn, request: Request):
            if body.user not in PERSONAS:
                raise Rejected(404, "unknown_persona")
            token = secrets.token_urlsafe(32)
            space = None
            if hosted is None:
                c = db.connect(db_path)
            else:
                app_name = hosted.app_of(request)
                if app_name is None:
                    raise Rejected(400, "app_header_required")
                # The only place a space is made: a browser without one signs in.
                space = hosted.resolve(request) or hosted.create(request, app_name)
                c = hosted.connect(space)
            try:
                with db.tx(c):
                    c.execute("INSERT INTO sessions(token, user_id, created_at) VALUES (?, ?, ?)",
                              (token, body.user, clock.now(c)))
            finally:
                c.close()
            resp = JSONResponse({"user": body.user, **PERSONAS[body.user]})
            if space is None:
                resp.set_cookie(cookie_name(request), token, httponly=True, samesite="strict", path="/")
            else:
                hosted.keep(resp, space, session=token)
            return resp

        @app.get("/api/demo/space")
        def space_info():
            """Whether demo data is private to this browser (hosted) or shared (local)."""
            if hosted is None:
                return {"private": False}
            return {"private": True, "idle_days": round(hosted.cfg.idle_seconds / 86400, 2)}

        @app.get("/api/demo/clock")
        def get_clock(c=Depends(conn)):
            return {"server_now": iso(clock.now(c)), "offset_seconds": clock.offset(c)}

        @app.post("/api/demo/clock")
        def advance(body: ClockIn, c=Depends(conn)):
            with db.tx(c):
                clock.advance(c, body.advance_seconds)
            return {"server_now": iso(clock.now(c)), "offset_seconds": clock.offset(c)}

        @app.post("/api/demo/reset")
        def reset(request: Request):
            """Shared: everyone's demo data. Hosted: only the caller's own space (kept, emptied)."""
            c = None
            if hosted is None:
                c = db.connect(db_path)
            elif (space := hosted.resolve(request)) is not None:
                try:
                    c = hosted.connect(space)
                except Rejected:
                    c = None  # already gone: nothing to delete
            if c is not None:
                try:
                    db.empty_demo_tables(c)
                finally:
                    c.close()
            resp = JSONResponse({"reset": True})
            if hosted is None:
                for name in (COOKIE, *APPS.values()):
                    resp.delete_cookie(name, path="/")
            elif (app_name := hosted.app_of(request)) is not None:
                hosted.end_session(resp, app_name)
            return resp

    @app.get("/api/session")
    def whoami(request: Request, response: Response, u: str = Depends(user)):
        if hosted is not None:
            # Each app load refreshes both cookies, so an active space keeps its full idle lifetime.
            name = session_cookie(request)
            hosted.keep(response, request.state.space, session=request.cookies.get(name) if name else None)
        return {"user": u, **PERSONAS[u]}

    @app.post("/api/enroll")
    def enroll(body: EnrollIn, u: str = Depends(user), c=Depends(conn)):
        """BG-03.2: bind a validated long-term public key to the authenticated account."""
        raw = validate_public_key(b64decode(body.public_key, "public_key"))
        with db.tx(c):
            if c.execute("SELECT 1 FROM enrolled_keys WHERE account_id = ?", (u,)).fetchone():
                raise Rejected(409, "already_enrolled")
            c.execute("INSERT INTO enrolled_keys(account_id, public_key, enrolled_at) VALUES (?, ?, ?)",
                      (u, raw, clock.now(c)))
        return {"account_id": u}

    @app.get("/api/directory")
    def directory(_: str = Depends(user), c=Depends(conn)):
        rows = c.execute("SELECT account_id, public_key FROM enrolled_keys ORDER BY account_id").fetchall()
        return [{"account_id": r["account_id"], "public_key": b64(r["public_key"]), **PERSONAS.get(r["account_id"], {})}
                for r in rows]

    @app.get("/api/mail")
    def mail(app_name: str, u: str = Depends(user), c=Depends(conn)):
        rows = c.execute("SELECT id, subject, body, at FROM mail WHERE to_user = ? AND app = ? ORDER BY id DESC",
                         (u, app_name)).fetchall()
        return [{"id": r["id"], "subject": r["subject"], "body": r["body"], "at": iso(r["at"])} for r in rows]

    def records_view(c, now: int, u: str, chain: str) -> dict:
        """Runs inside one BEGIN IMMEDIATE transaction: the membership check,
        any Last Light transition it records, and the read of entries all see
        one snapshot. The receipt is derived from the returned entries, so it
        can never name more rows than the response contains."""
        if chain.startswith("ll:"):
            lastlight.get_vault(c, now, u, chain[3:])  # membership check; records due lantern transitions
        elif chain != "bg" or PERSONAS[u]["app"] != "break-glass":
            raise Rejected(404, "not_found")
        entries = chain_entries(c, chain)
        rec = {"length": entries[-1]["seq"], "head": entries[-1]["hash"]} if entries else receipt(c, chain)
        return {"entries": entries, "receipt": rec}

    @app.get("/api/records/{chain}")
    def records(chain: str, u: str = Depends(user), c=Depends(conn)):
        return run(c, records_view, u, chain)

    # -- Break Glass ----------------------------------------------------------

    @app.get("/api/bg/items")
    def bg_items(_: str = Depends(user), c=Depends(conn)):
        return petitions.list_items(c)

    @app.post("/api/bg/items")
    def bg_create_item(body: ItemIn, u: str = Depends(user), c=Depends(conn)):
        if PERSONAS[u]["role"] != "Item admin":
            raise Rejected(403, "not_item_admin")
        return run(c, petitions.create_item, u, body.item_id, body.name)

    @app.post("/api/bg/items/{item_id}/seal-versions")
    def bg_seal(item_id: str, body: SealIn, u: str = Depends(user), c=Depends(conn)):
        shares = {k: b64decode(v, "approver share") for k, v in body.approver_shares.items()}
        return run(c, petitions.activate_seal_version, u, item_id, body.seal_version_id, body.threshold,
                   body.approver_ids, b64decode(body.header, "header"), b64decode(body.ciphertext, "ciphertext"), shares)

    @app.post("/api/bg/items/{item_id}/rotation-confirmed")
    def bg_rotated(item_id: str, u: str = Depends(user), c=Depends(conn)):
        return run(c, petitions.confirm_rotation, u, item_id)

    @app.post("/api/bg/petitions")
    def bg_open(body: PetitionIn, u: str = Depends(user), c=Depends(conn)):
        key = b64decode(body.requester_public_key, "requester_public_key")
        return run(c, petitions.create_petition, u, body.item_id, body.reason, body.requested_window_seconds, key)

    @app.get("/api/bg/petitions")
    def bg_list(u: str = Depends(user), c=Depends(conn)):
        return run(c, petitions.list_petitions, u)

    @app.get("/api/bg/petitions/{pid}")
    def bg_status(pid: str, u: str = Depends(user), c=Depends(conn)):
        return run(c, petitions.status, u, pid)

    @app.get("/api/bg/petitions/{pid}/approver-share")
    def bg_approver_share(pid: str, u: str = Depends(user), c=Depends(conn)):
        return run(c, petitions.approver_share, u, pid)

    @app.post("/api/bg/petitions/{pid}/approvals")
    def bg_approve(pid: str, body: EnvelopeIn, u: str = Depends(user), c=Depends(conn)):
        return run(c, petitions.approve, u, pid, b64decode(body.envelope, "envelope"))

    @app.post("/api/bg/petitions/{pid}/deny")
    def bg_deny(pid: str, u: str = Depends(user), c=Depends(conn)):
        return run(c, petitions.deny, u, pid)

    @app.get("/api/bg/petitions/{pid}/release")
    def bg_release(pid: str, u: str = Depends(user), c=Depends(conn)):
        return run(c, petitions.release, u, pid)

    # -- Last Light -----------------------------------------------------------

    @app.post("/api/ll/vaults")
    def ll_create(body: VaultIn, u: str = Depends(user), c=Depends(conn)):
        data = body.model_dump()
        data["header"] = b64decode(body.header, "header")
        data["owner_key_blob"] = b64decode(body.owner_key_blob, "owner_key_blob")
        data["trustee_shares"] = {k: b64decode(v, "trustee share") for k, v in body.trustee_shares.items()}
        return run(c, lastlight.create_vault, u, data)

    @app.get("/api/ll/vaults")
    def ll_list(u: str = Depends(user), c=Depends(conn)):
        return run(c, lastlight.list_vaults, u)

    @app.get("/api/ll/vaults/{vid}")
    def ll_get(vid: str, u: str = Depends(user), c=Depends(conn)):
        return run(c, lastlight.get_vault, u, vid)

    @app.post("/api/ll/vaults/{vid}/items")
    def ll_add_item(vid: str, body: VaultItemIn, u: str = Depends(user), c=Depends(conn)):
        data = body.model_dump()
        data["wrapped_key"] = b64decode(body.wrapped_key, "wrapped_key")
        data["ciphertext"] = b64decode(body.ciphertext, "ciphertext")
        return run(c, lastlight.add_item, u, vid, data)

    @app.get("/api/ll/vaults/{vid}/owner-key")
    def ll_owner_key(vid: str, u: str = Depends(user), c=Depends(conn)):
        return run(c, lastlight.owner_key, u, vid)

    @app.get("/api/ll/vaults/{vid}/my-share")
    def ll_my_share(vid: str, u: str = Depends(user), c=Depends(conn)):
        return run(c, lastlight.my_share, u, vid)

    @app.post("/api/ll/vaults/{vid}/card-issued")
    def ll_card(vid: str, u: str = Depends(user), c=Depends(conn)):
        return run(c, lastlight.card_printed, u, vid)

    @app.post("/api/ll/vaults/{vid}/checkin")
    def ll_checkin(vid: str, u: str = Depends(user), c=Depends(conn)):
        return run(c, lastlight.checkin, u, vid)

    @app.post("/api/ll/vaults/{vid}/recoveries")
    def ll_open_recovery(vid: str, body: RecoveryIn, u: str = Depends(user), c=Depends(conn)):
        return run(c, lastlight.open_recovery, u, vid, b64decode(body.public_key, "public_key"))

    @app.post("/api/ll/recoveries/{rid}/shares")
    def ll_submit(rid: str, body: EnvelopeIn, u: str = Depends(user), c=Depends(conn)):
        return run(c, lastlight.submit_share, u, rid, check_envelope(b64decode(body.envelope, "envelope")))

    @app.get("/api/ll/recoveries/{rid}/package")
    def ll_package(rid: str, u: str = Depends(user), c=Depends(conn)):
        return run(c, lastlight.recovery_package, u, rid)

    @app.get("/api/ll/vaults/{vid}/bundle")
    def ll_bundle(vid: str, u: str = Depends(user), c=Depends(conn)):
        return run(c, lastlight.bundle, u, vid)

    return app


def app_from_env() -> FastAPI:
    """Hosted when COVEN_SPACES_DIR is set; otherwise the shared database at COVEN_DB."""
    cfg = SpaceConfig.from_env()
    if cfg is not None:
        return create_app(None, spaces=cfg)
    return create_app(os.environ.get("COVEN_DB", "coven-demo.sqlite"))
