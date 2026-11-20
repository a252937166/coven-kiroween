# AG-01 Printed Last Light card

Source: [spec 05 requirements, AG-01](../../.kiro/specs/05-petition-lifecycle-and-binding/requirements.md) and the acceptance-evidence section of [guarantees.md](../../.kiro/steering/guarantees.md).

**Passed on November 20, 2026** with a paper card and matching encrypted bundle exported from the public Last Light site. The first physical run passed on November 8.

## What it proves

1. A share read from an actual printed card, plus enough other valid shares, recovers a fictional Last Light item with the offline tool while the service is stopped.
2. Generating and printing the card sends no raw share, QR payload or word code to the service, telemetry or logs.

## Dependencies

| Dependency | Why it cannot be replaced |
|---|---|
| Physical printer and paper | The gate reads the share from the printed card. A screen rehearsal is useful but does not pass the gate. |
| A person reading the card | The QR is scanned from paper, or the word code is typed from paper. |
| Last Light share-card view ("My share card" in `apps/last-light`) | Generates the card in the browser. |
| Offline tool `core-ts/bin/recover.js` | Performs recovery with the service stopped. |
| Capture scanner `scripts/scan-capture.mjs` (spec 05 task 9.2) | Searches the captured data. |

## Fixtures

Use only the fictional demo family vault ("Set up demo" in Last Light: Mara Hollow and trustees Ada, Bram, Cleo, Dov, Esme, 3 of 5) and its sample letter, which contains "blue pumpkin". Never use a real secret, a real person's name or a real address.

## Procedure

1. Start the service in demo mode with a fresh fictional vault. Start a capture of:
   - every browser request to the service (browser devtools "Save all as HAR", or a local proxy bound to 127.0.0.1),
   - service stdout, stderr and log files,
   - any telemetry sink configured for the run (demo mode ships none; record that fact).
2. In the browser, sign in as a trustee (for example Bram), click "Show my card", then "Print card" and print it on paper. As any trustee, click "Download bundle" and save it as `bundle.json` in the repository root.
3. While the card view is still open, copy its word code into `secrets.local.txt` **outside the repository**, one share per line. If you also scan the QR from paper later, add the `coven1:` text your reader shows. This file is used only by the scanner.
4. Stop the capture. Stop the service. Confirm it is stopped (the app's health URL fails).
5. Read the share from the paper: scan the QR with a phone or webcam reader (it shows `coven1:...` text), or read the word code. Get two more fictional shares from other trustees' cards (printed, or written down from their card view before the service was stopped).
6. From the repository root, run `node core-ts/bin/recover.js bundle.json`. It asks for shares on stdin: enter the share from paper and the two others, one per line, then an empty line. Entering shares on stdin keeps them out of shell history. Expect the sample letter's text ("blue pumpkin").
7. Run `node scripts/scan-capture.mjs <capture-dir> secrets.local.txt`. It searches for each secret as raw hex, base64, base64url, the `coven1:` payload and the word code with and without separators, in any case. It prints only file names and offsets, never the matched value.
8. Delete `secrets.local.txt`.

## Scripted capture

Steps 1 to 4 and 7 can be run with helper scripts. They write share values only to owner-only files in a private run directory outside the repository, and never print them or pass them as arguments.

1. `scripts/ag01-stack.sh service <run-dir>` and `scripts/ag01-stack.sh preview <run-dir>`: an isolated service (127.0.0.1:8807, fresh database) and Last Light preview (127.0.0.1:5193). The normal demo ports are untouched.
2. `node --experimental-strip-types scripts/ag01-capture.ts <run-dir> http://127.0.0.1:5193`: a fresh browser context with a HAR of every request. It writes Bram's card as `bram-share-card.pdf`, plus `bundle.json`, the scanner input `secrets.local.txt`, two supplementary fictional shares and `run-facts.json` (non-secret).
3. `scripts/ag01-stack.sh stop`: stops both and checks that they are unreachable.
4. `node scripts/scan-capture.mjs <run-dir>/capture <run-dir>/secrets.local.txt`.
5. After a person prints the PDF and reads the share back from paper into `<run-dir>/paper-readback.local.txt`, run `scripts/ag01-offline.sh <run-dir>`. It checks the stack is unreachable, confirms the read-back is the printed share without printing it, and runs `node core-ts/bin/recover.js bundle.json` from the root with shares on stdin.

## Result: run-20261107 (PASS)

| Item | Value |
|---|---|
| Verdict | **PASS** under the pass rule above (CLI text found, scanner no match) |
| Run date | Capture 2026-11-07 about 18:55 UTC; paper read-back and offline run 2026-11-08, 03:07 EST |
| Code under test | Card, bundle and capture from commit `7665e0d` (helpers `d64ffaa`). Offline run on `65ce2f4`; `core-ts/` and `service/` are unchanged between `7665e0d` and `65ce2f4` |
| Card | Trustee Bram (fictional), "The Hollow family vault (fictional)", 3 of 5. Receipt at issuance `7:5a7be605fdb965c1f9c668fec6c5eb6dd1011adfa0d2514ad9944697f66a11d2` |
| Paper provenance | The owner confirmed they printed Bram's card on physical paper and typed the word code directly from the paper into an owner-only file (mode 0600) |
| Read-back | Decodes with a valid checksum; it is the same share as the printed card (checked without printing it) |
| Isolated stack | Service 127.0.0.1:8807 and preview 127.0.0.1:5193 unreachable before and after the offline run |
| Offline recovery | `node core-ts/bin/recover.js bundle.json` from the repo root, three shares on stdin (paper share plus Dov and Esme, fictional): exit 0, vault opened (3 items), expected letter text found |
| Scanner | `scripts/scan-capture.mjs` with the run's scanner input (33 forms): no match in the capture (HAR, service stdout and stderr, preview log, telemetry note), the bundle, or the offline CLI output |
| Telemetry | Demo ships no telemetry sink; recorded in the private telemetry note |
| Cleanup | `secrets.local.txt` deleted after verification (step 8). Raw shares, PDF, bundle, HAR and CLI output stay private, outside the repository |
| Evidence gap | No redacted photo of the printed card has been provided. The photo is listed under "Evidence to keep" but is not part of the pass rule; it remains outstanding |

AG-02 (clean public checkout of the submission commit) is a separate gate and is still pending.

## November 20 public deployment result

At 14:25:49 UTC the owner finished entering the word code from Bram’s printed card for the November 19 HTTPS export. The local helper checked the code against the issued card. Before sandboxing, the local control and the public deployment both returned HTTP 200. Inside the network-denied sandbox neither was reachable.

The offline CLI rejected the paper share on its own (exit 1). With two additional matching trustee shares and the encrypted bundle, it recovered the expected family letter (exit 0). The scanner found zero matches for the 33 tested representations of the shares in the captured browser traffic, service log and configuration notes, or the encrypted bundle. The [deployment record](judge-hosting-2026-11-19.md) identifies the tested release.

## Pass rule

Pass when step 6 prints the expected text **and** step 7 exits 0 with no matches.

## Evidence to keep

- Photo of the printed card with the QR and word code covered.
- The HAR, the log files and the scanner output.
- The CLI output from step 6.
- The commit SHA of the code under test and the date.

Record the result in `KIRO_USAGE.md` under "Acceptance evidence".
