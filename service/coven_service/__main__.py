"""Run the demo service.

Local (shared, the default): python -m coven_service [--port 8787] [--db coven-demo.sqlite]
Hosted (a private demo space per browser and app):
    python -m coven_service --port 8787 --spaces-dir /var/lib/coven/spaces

Always binds to 127.0.0.1: a hosted deployment puts an HTTPS reverse proxy in
front, on the same host. Client addresses come from that proxy's
X-Forwarded-For, trusted only from 127.0.0.1. Uvicorn's own access log is off;
the app logs an allowlist of fields per request and never request or response
bodies, cookies or tokens.
"""

import argparse
import logging
import os

import uvicorn

# Hosted-mode flags and the environment variables the app factory reads.
SPACE_FLAGS = (
    ("spaces_max", "COVEN_SPACES_MAX"),
    ("space_idle_hours", "COVEN_SPACE_IDLE_HOURS"),
    ("space_min_idle_minutes", "COVEN_SPACE_MIN_IDLE_MINUTES"),
    ("space_max_mb", "COVEN_SPACE_MAX_MB"),
    ("spaces_per_client", "COVEN_SPACES_PER_CLIENT"),
)


def main() -> None:
    parser = argparse.ArgumentParser(prog="coven_service")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--db", default=os.environ.get("COVEN_DB", "coven-demo.sqlite"), help="shared mode database")
    parser.add_argument("--spaces-dir", default=os.environ.get("COVEN_SPACES_DIR"),
                        help="hosted mode: keep one private demo space per browser and app in this directory")
    parser.add_argument("--spaces-max", type=int, help="most spaces at once (default 200)")
    parser.add_argument("--space-idle-hours", type=float, help="delete a space unused this long (default 168)")
    parser.add_argument("--space-min-idle-minutes", type=float,
                        help="when full, only a space idle at least this long makes room (default 30)")
    parser.add_argument("--space-max-mb", type=float, help="size cap of one space (default 2)")
    parser.add_argument("--spaces-per-client", type=int, help="most spaces per client address (default 24)")
    parser.add_argument("--insecure-cookies", action="store_true",
                        help="hosted mode over plain http, for local tests only: no Secure flag, no __Host- prefix")
    args = parser.parse_args()
    os.environ["COVEN_DB"] = args.db
    if args.spaces_dir:
        os.environ["COVEN_SPACES_DIR"] = args.spaces_dir
        for attr, env in SPACE_FLAGS:
            if getattr(args, attr) is not None:
                os.environ[env] = str(getattr(args, attr))
        if args.insecure_cookies:
            os.environ["COVEN_INSECURE_COOKIES"] = "1"
    else:
        os.environ.pop("COVEN_SPACES_DIR", None)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    uvicorn.run(
        "coven_service.app:app_from_env", factory=True, host="127.0.0.1", port=args.port, access_log=False,
        proxy_headers=True, forwarded_allow_ips="127.0.0.1",
    )


if __name__ == "__main__":
    main()
