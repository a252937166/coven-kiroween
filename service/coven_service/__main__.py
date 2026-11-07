"""Run the local demo service: python -m coven_service [--port 8787] [--db coven-demo.sqlite]

Always binds to 127.0.0.1. Uvicorn's own access log is off; the app logs an
allowlist of fields per request and never request or response bodies.
"""

import argparse
import logging
import os

import uvicorn


def main() -> None:
    parser = argparse.ArgumentParser(prog="coven_service")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--db", default=os.environ.get("COVEN_DB", "coven-demo.sqlite"))
    args = parser.parse_args()
    os.environ["COVEN_DB"] = args.db
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    uvicorn.run("coven_service.app:app_from_env", factory=True, host="127.0.0.1", port=args.port, access_log=False)


if __name__ == "__main__":
    main()
