#!/usr/bin/env bash
# AG-01 offline step (docs/acceptance/AG-01-printed-card.md, steps 4 and 6).
#
#   scripts/ag01-offline.sh <private-run-dir>
#
# Needs <dir>/paper-readback.local.txt: the share as a person read it from the
# printed card (word code typed from paper, or the coven1: text a phone shows
# after scanning the paper QR), on one line.
#
# 1. Confirms the isolated service and preview are unreachable.
# 2. Reports, without printing values, whether the read-back share decodes and
#    is the same share as the card that was printed.
# 3. Runs the offline tool from the repository root with the read-back share and
#    the two supplementary fictional shares on stdin (never as arguments).
# Output goes to <dir>/offline-recovery.out. No share value is printed.
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN="${1:?usage: $0 <private-run-dir>}"
READBACK="$RUN/paper-readback.local.txt"
[ -s "$READBACK" ] || { echo "missing $READBACK (read the share from paper first)"; exit 2; }
chmod 600 "$READBACK"

for url in http://127.0.0.1:8807/api/personas http://127.0.0.1:5193/; do
  if curl -s -m 3 -o /dev/null "$url"; then echo "service still reachable: $url"; exit 1; fi
  echo "unreachable: $url"
done

cd "$ROOT"
node --experimental-strip-types --no-warnings --input-type=module - "$READBACK" "$RUN/secrets.local.txt" <<'EOF'
import { readFileSync } from "node:fs";
import { decodeShareText } from "./core-ts/src/shares.ts";
const [readback, secrets] = process.argv.slice(2);
const read = decodeShareText(readFileSync(readback, "utf8").trim());
const printed = decodeShareText(readFileSync(secrets, "utf8").split("\n")[0].trim());
const same = Buffer.from(read.share).equals(Buffer.from(printed.share)) && Buffer.from(read.tag).equals(Buffer.from(printed.tag));
console.log(`read-back share decodes (checksum ok): yes; same share as the printed card: ${same ? "yes" : "NO"}`);
if (!same) process.exit(1);
EOF

# One share per line, blank lines dropped, then the empty line that ends input.
{ grep -v '^[[:space:]]*$' "$READBACK"; grep -v '^[[:space:]]*$' "$RUN/supplementary-shares.local.txt"; echo; } | node core-ts/bin/recover.js "$RUN/bundle.json" > "$RUN/offline-recovery.out" 2> "$RUN/offline-recovery.err" || {
  echo "offline recovery FAILED; see $RUN/offline-recovery.err"; exit 1; }
grep -q "${EXPECT:-blue pumpkin}" "$RUN/offline-recovery.out" && echo "offline recovery: expected sample letter text found" || { echo "expected text NOT found"; exit 1; }
grep -E "^(Recovered vault|== )" "$RUN/offline-recovery.out"
