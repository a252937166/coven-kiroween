#!/usr/bin/env bash
# Disposable service + preview for checks (print geometry, screenshots).
#   scripts/scratch-stack.sh service <dir> <service-port>
#   scripts/scratch-stack.sh preview <app> <preview-port> <service-port>
#   scripts/scratch-stack.sh stop <port>...
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
case "${1:-}" in
  service)
    cd "$ROOT/service"
    exec .venv/bin/python -m coven_service --port "$3" --db "$2/scratch.sqlite" > "$2/service.log" 2>&1
    ;;
  preview)
    cd "$ROOT/apps/$2"
    # optional 5th argument: a build directory other than dist/
    COVEN_SERVICE="http://127.0.0.1:$4" exec npx vite preview --port "$3" ${5:+--outDir "$5"} > /dev/null 2>&1
    ;;
  stop)
    shift
    for p in "$@"; do
      pids="$(lsof -nP -iTCP:"$p" -sTCP:LISTEN -t 2>/dev/null || true)"
      [ -n "$pids" ] && kill $pids || true
    done
    ;;
  *) echo "usage: see header" >&2; exit 2 ;;
esac
