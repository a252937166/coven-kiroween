#!/usr/bin/env bash
# Isolated AG-01 stack: a fresh service and a Last Light preview on their own
# ports and database, so the normal demo on 8787/5173/5174 is untouched.
#
#   scripts/ag01-stack.sh service <private-run-dir>   # foreground; logs to <dir>/capture/
#   scripts/ag01-stack.sh preview <private-run-dir>   # foreground
#   scripts/ag01-stack.sh stop                        # stops both, then checks they are unreachable
#
# Demo telemetry: the service and apps ship no telemetry sink, so there is no
# telemetry stream to capture. Logs are the service's stdout and stderr.
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_PORT=8807
PREVIEW_PORT=5193

case "${1:-}" in
  service)
    RUN="$2"
    cd "$ROOT/service"
    exec .venv/bin/python -m coven_service --port "$SERVICE_PORT" --db "$RUN/ag01.sqlite" \
      > "$RUN/capture/service.stdout.log" 2> "$RUN/capture/service.stderr.log"
    ;;
  preview)
    RUN="$2"
    cd "$ROOT/apps/last-light"
    COVEN_SERVICE="http://127.0.0.1:$SERVICE_PORT" exec npx vite preview --port "$PREVIEW_PORT" > "$RUN/capture/preview.log" 2>&1
    ;;
  stop)
    for p in "$SERVICE_PORT" "$PREVIEW_PORT"; do
      pids="$(lsof -nP -iTCP:"$p" -sTCP:LISTEN -t 2>/dev/null || true)"
      [ -n "$pids" ] && kill $pids || true
    done
    sleep 2
    ok=1
    for url in "http://127.0.0.1:$SERVICE_PORT/api/personas" "http://127.0.0.1:$PREVIEW_PORT/"; do
      if curl -s -m 3 -o /dev/null "$url"; then echo "STILL REACHABLE: $url"; ok=0; else echo "unreachable: $url"; fi
    done
    [ "$ok" = 1 ]
    ;;
  *)
    echo "usage: $0 service|preview <private-run-dir> | stop" >&2
    exit 2
    ;;
esac
