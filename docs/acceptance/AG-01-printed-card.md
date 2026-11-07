# AG-01 Printed Last Light card

Source: [spec 05 requirements, AG-01](../../.kiro/specs/05-petition-lifecycle-and-binding/requirements.md) and the acceptance-evidence section of [guarantees.md](../../.kiro/steering/guarantees.md).

Status: **defined in M0, not runnable yet.** It needs the Last Light recovery flow (M2) and a physical printer.

## What it proves

1. A share read from an actual printed card, plus enough other valid shares, recovers a fictional Last Light item with the offline tool while the service is stopped.
2. Generating and printing the card sends no raw share, QR payload or word code to the service, telemetry or logs.

## Dependencies

| Dependency | Why it cannot be replaced |
|---|---|
| Physical printer and paper | The gate reads the share from the printed card. A screen rehearsal is useful but does not pass the gate. |
| A person reading the card | The QR is scanned from paper, or the word code is typed from paper. |
| Last Light share-card view (spec 02, spec 10) | Generates the card in the browser. |
| Offline tool `core-ts` `recover-cli` (spec 03) | Performs recovery with the service stopped. |
| Capture scanner `scripts/scan-capture.mjs` (spec 05 task 9.2) | Searches the captured data. |

## Fixtures

Use only the fictional demo family vault (3 of 5 trustees) and its sample letter. Never use a real secret, a real person's name or a real address.

## Procedure

1. Start the service in demo mode with a fresh fictional vault. Start a capture of:
   - every browser request to the service (browser devtools "Save all as HAR", or a local proxy bound to 127.0.0.1),
   - service stdout, stderr and log files,
   - any telemetry sink configured for the run (demo mode ships none; record that fact).
2. In the browser, open trustee 1's share card. Print it. Export the bundle to `bundle.json`.
3. While the card view is still open, copy its QR payload and word code into `secrets.local.txt` **outside the repository**. This file is used only by the scanner.
4. Stop the capture. Stop the service. Confirm it is stopped (the app's health URL fails).
5. Read the share from the paper: scan the QR with a phone or webcam reader, or type the word code. Get two more shares from other trustees' cards or digital shares.
6. Run `node recover.js bundle.json --share <from paper> --share <2> --share <3>`. Expect the sample letter's text.
7. Run `node scripts/scan-capture.mjs <capture-dir> secrets.local.txt`. It searches for each secret as raw hex, base64, base64url, the `coven1:` payload and the word code with and without separators, in any case. It prints only file names and offsets, never the matched value.
8. Delete `secrets.local.txt`.

## Pass rule

Pass when step 6 prints the expected text **and** step 7 exits 0 with no matches.

## Evidence to keep

- Photo of the printed card with the QR and word code covered.
- The HAR, the log files and the scanner output.
- The CLI output from step 6.
- The commit SHA of the code under test and the date.

Record the result in `KIRO_USAGE.md` under "Acceptance evidence".
