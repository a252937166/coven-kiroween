# AG-01 Printed Last Light card

Source: [spec 05 requirements, AG-01](../../.kiro/specs/05-petition-lifecycle-and-binding/requirements.md) and the acceptance-evidence section of [guarantees.md](../../.kiro/steering/guarantees.md).

Status: **pending.** The recovery flow, the share-card view, the offline tool and the scanner exist and pass a screen rehearsal (`e2e/demos.spec.ts`). The gate itself still needs a card printed on paper and read back by a person. A rehearsal from a screen is not a pass.

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

## Pass rule

Pass when step 6 prints the expected text **and** step 7 exits 0 with no matches.

The gate stays **pending** until a person runs it with a paper card. AG-02 (the final public checkout of the submission commit) is a separate gate and is also pending.

## Evidence to keep

- Photo of the printed card with the QR and word code covered.
- The HAR, the log files and the scanner output.
- The CLI output from step 6.
- The commit SHA of the code under test and the date.

Record the result in `KIRO_USAGE.md` under "Acceptance evidence".
