# Implementation Plan

Each task lists the requirement IDs (or guarantee labels GR-ROT, GR-LOG from design.md) it serves and the checks from [design.md](design.md) "Testing Strategy" that verify it. Write each check before or with the code it verifies.

Status markers:

- `[x]` done: the listed check ran and passed. The progress log names the run.
- `[ ]` not done. A note "written, not run" means code or docs exist but no check has passed yet.

Tasks 0, 9 and 10 are M0. Tasks 1 to 8 are M1 and M3.

## Progress log

Newest first. Another run resumes from the first entry.

- **2026-11-07, run 8 (Kiro in Kiro Crew): session single-flight.** One page-wide lock (`ui-kit/src/session.ts`) is taken synchronously, so only one sign-in sequence can run at a time. It covers start-up, manual role switches and the multi-persona "Set up demo" (internal sign-ins and key enrollments). After every sign-in, including a failed or ambiguous one, the UI reads `GET /api/session` and shows that persona. Re-selecting the current persona sends nothing. While the lock is held, the role selector is disabled, and the main area, the demo controls and Last Light's proof area are `inert` and `aria-busy`. Role-scoped data is not loaded. No backend change; no visible design change (the Break Glass demo strip keeps its position through a wrapper); the print CSS and card are untouched.
  - Checks: `ui-kit/test/session.test.ts` (a second sequence started while one is pending never runs; the lock is released on failure). New Chromium test "Break Glass session lock": `POST /api/session` is held 1.5 s. The selector is disabled, the desk is inert and busy, the demo buttons cannot take focus, and the desk's "New petition" is absent. A forced second switch starts no sign-in (1 POST, at most 1 in flight). Afterwards the selector equals `GET /api/session` (Sage) and the desk is active again. Re-selecting Sage sends 0 sign-ins.
  - Runs: root typecheck 0 errors; build OK; `npm test` (core 40, service 32, ui-kit 5, scanner self-test, AG-02 fixtures 9); Playwright 5 of 5, twice. Previews on 5173 and 5174 serve this build. Screenshots were not recaptured (appearance unchanged).
  - AG-01 physical read-back remains **pending**. The private run is untouched.

- **2026-11-07, run 7 (Kiro in Kiro Crew): role isolation fixes after independent review.** No change to appearance or to the printed card.
  - Shared: a role epoch (`ui-kit/src/components.tsx`) is bumped synchronously when a persona switch starts, before the new session cookie exists. Async work captures it, and the ui-kit flows take a guard that is checked right before each request and before any decryption (`StaleFlowError`). Late responses never reach the next persona's view, and no follow-up request is sent under the next session.
  - Last Light: `ShareCard` and `RecoveryPanel` are keyed by persona, epoch, vault and recovery, so a typed code, an old card or a late `myCard()` or decrypt result is dropped on switch. The lantern's Released label now says the encrypted package was sent.
  - Break Glass:
    - Plaintext is bound to the viewer, the ticket and the epoch, and is gated at render (requester only). The ticket is keyed by persona and epoch.
    - Stale queue and ticket responses are discarded, and the desk shows "Loading the desk for …" until data for the current persona arrives.
    - "Hide" is restored and clears the plaintext. Leaving a ticket also clears it.
    - A new petition opened from a link view clears the fragment and shows the new ticket.
    - Released copy now says the encrypted package was sent. "Decrypted and verified in this browser" appears only after `openRelease` succeeds.
  - Browser regression checks (`e2e/demos.spec.ts`). The delays hold only the response, after the request has gone out as the original persona:
    - Robin's release response is held 1.5 s while switching to Sage: no plaintext for Sage. Robin then retrieves normally.
    - Leaving and reselecting the ticket, and Hide plus reselect, reveal nothing.
    - A new petition from a link view clears the fragment.
    - Bram's `my-share` response is held while switching to Cleo: no card, and no `card-issued` request.
    - A word code pasted but not submitted is empty after switching away and back.
    - Existing assertions are kept.
  - Mutation evidence:
    - Removing the Break Glass release guards (ticket key, bound release, render gate, retrieve guard) fails the new test at "no `.secret` for Sage".
    - Removing the Last Light keys plus the epoch check fails at "no `.share-card` for Cleo".
    - Both were restored.
  - Runs: root typecheck 0 errors; build OK; `npm test` (core 40, service 32, ui-kit 3, scanner self-test, AG-02 fixtures 9); Playwright 4 of 4, twice. Print parity versus the 7665e0d baseline: 0 differences inside `.share-card`, only the wrapper's inherited color as before; PDF page 1 has 347 characters, page 2 is blank. Theme and Last Light CSS are untouched. Screenshots in `docs/screenshots/` refreshed (0 px overflow, content masked).
  - Limitation: a release response discarded by the guard has still been served, so the petition shows Released. The key stays in the browser, and the requester can retrieve again inside the window.
  - AG-01 physical read-back remains **pending**. The private run is untouched.

- **2026-11-07, run 6 (Kiro in Kiro Crew): UI redesign of both apps.** Workflows, copy about guarantees, role guards, CSP and print boundaries are unchanged. Last Light is now a family-archive folio with an inline lantern that follows the real lifecycle state. Break Glass is now an incident desk with a request queue beside a petition ticket. Mail, receipts and fingerprints moved to secondary disclosures. Receipt outcomes have distinct text and tone. No external requests at runtime.
  - Print boundary: the CSS rules that reach the share card and the `@media print` block are byte-identical to 7665e0d, and the card JSX is unchanged. `scripts/print-geometry.ts` compares layout and computed styles of the 16 print-subtree nodes in print media, before and after: 0 differences inside `.share-card`. The only differences are the color and border-color inherited by the borderless, text-free `.print-area` wrapper (now the new ink color). The A4 PDF from the revised build has 347 text characters on page 1 and none on page 2, the same as the run-20261107 PDF. No other page content appears in it. Physical AG-01 does not need repeating for these changes. Its evidence still names the 7665e0d build.
  - Checks: root typecheck 0 errors; build OK; `npm test` (core 40, service 32, ui-kit 3, scanner self-test, AG-02 fixtures 9); Playwright 3 of 3. Selectors moved to `data-testid` state chips and exact button names (`/^Approve:/`), with no assertion removed.
  - Screenshots: `docs/screenshots/` (1440 px and 390 px; first run and main outcome for each app; focus frames at 390 px). Revealed letters and the released credential are masked, and no share card is on screen. `report.json` records 0 px horizontal overflow for every frame. Text and background pairs measure 5.46:1 or higher (WCAG AA).
  - AG-01 remains **pending** the person's paper read-back. `scripts/ag01-capture.ts` now opens the "Offline bundle" disclosure; it was not re-run, and the private run is untouched.

- **2026-11-07, run 4 (Kiro in Kiro Crew), review pass from 87b5879.** No new milestone was opened. Results, all on fictional data:
  - **Scenario 3 in the browser (T-05, BG-01.3).** Break Glass now issues a same-origin petition link, `/#petition=<id>`, holding only the opaque ID in the fragment (no query string). A new Playwright test reuses two links in Chromium. Link A was retrieved inside the window. Link B was approved but not retrieved, so its key stayed local. After the labelled demo clock passed expiry, Robin (valid session, key still local) clicked Retrieve on link B. The service refused with 410 and the screen showed "Retrieval refused: the petition is expired". Then the key was deleted. In-page `fetch` of both links returned 410 with no release fields. Kit (ineligible) got 404 and no material before and after expiry. Ash (an approver, not the requester) got 404. The copy "Anything you already copied or downloaded stays usable after that." stays visible on the expired link. Mutation check: with the service's release-time expiry check removed, this test failed at the refusal step, and the code was then restored.
  - **Canonical JSON (invariant 9).** `core-ts` now escapes U+007F like Python `ensure_ascii=True`. New shared fixture `fixtures/record-vectors.json` (9 vectors: U+007F, U+007E, controls, quotes, Latin-1, BMP, astral, nested keys) is generated by the Python service and asserted by `core-ts/test/records-vectors.test.ts` and `service/tests/test_records.py`. With the old escaping restored, the TypeScript fixture test failed 2 of 2; with the fix it passes.
  - **Records endpoint.** `GET /api/records/{chain}` now runs in one `BEGIN IMMEDIATE` transaction. It records due Last Light transitions, then reads the entries, and derives the receipt from the entries it returns. New tests: transitions are observed without a prior vault read, and 40 reads during concurrent appends each return `receipt.length == len(entries)` with a consistent chain. The race was not reproduced against the old code, so this test checks the property but has not been shown to catch the old race.
  - **Last Light release wording and retry.** The service marks the vault Released when it serves the encrypted package. The screens, mail and code comments now say that, and they say the key is rebuilt and checked in the recoverer's browser. The success note appears only after the header check passes. The client sets aside contributions that do not decrypt, tries k-subsets against the header, and otherwise names the unusable trustees (`RecoveryIncompleteError`). After release, trustees who have not submitted may add a share to the same recovery, and the recoverer retries. A trustee cannot replace a counted contribution. Owner check-in stays refused after release. Tested with real envelopes over HTTP in `ui-kit/test/flows.test.ts`: Cleo's real share sealed to the wrong recovery ID, Released after the package was served, retry fails naming Cleo, check-in returns 409, Dov adds a share, the retry opens the vault. Also tested in `core-ts/test/release.test.ts` (wrong binding; a decryptable wrong share) and `service/tests/test_lastlight.py`. If no other trustee can add a share, recovery falls back to offline cards plus the bundle. The browser UI shows this path but no Playwright test drives it.
  - **AG-01 guide** now uses `node core-ts/bin/recover.js bundle.json` from the repository root with shares entered on stdin. Checked from the root with a fictional bundle and three fictional shares on stdin. The gate stays pending, and so does AG-02.
  - Runs: `npm test` passes: core-ts 40 of 40, service 32 of 32, ui-kit 3 of 3, scanner self-test, AG-02 fixtures 9 of 9. `npm run typecheck`: 0 errors. `npx playwright test -c e2e`: 3 of 3. Apps rebuilt; service and previews restarted on 8787, 5173 and 5174 with the existing demo database.

- **2026-11-07, run 3 (Kiro in Kiro Crew).** Resumed from commit 6136333 and the CLI run's dependency changes (kept). Built and tested tasks 1 to 8 and 9.2. Commands and results, all on fictional data:
  - `npm test --workspace core-ts`: 35 of 35 pass (node:test + fast-check). Covers T-07, T-10, T-12, T-13 and proposal invariants 1, 3 and 9 (TypeScript side), the offline CLI and the records known-answer vector shared with Python.
  - `npm run test:service`: 28 of 28 pass (pytest + Hypothesis). Covers T-01 to T-11, T-14, T-15, D1, the Last Light lifecycle and invariant 9. A planted bug (quorum check removed) made 4 HTTP tests and the `RuleBasedStateMachine` fail, then the code was restored.
  - `npm test --workspace ui-kit`: 2 of 2 pass. Real core-ts cryptography through the real service over HTTP for acceptance scenarios 1 to 4, including CLI recovery from card codes.
  - `npx playwright test -c e2e`: 2 of 2 pass in Chromium against built apps served with the strict CSP. Break Glass: quorum, duplicate approval, other user refused, single-item release, rotation. Last Light: cards, check-in cancels, typed word code, recovery, bundle, offline CLI, and a scan of requests, service log and bundle for share text (no match).
  - `node scripts/scan-capture.mjs --self-test`: PASS. Scanner run on that browser run's service log and bundle with Bram's card code: no match.
  - `scripts/check-kiro-tracked.sh . HEAD` on 12300a0: AG-02 PASS (rehearsal only). `scripts/test-check-kiro-tracked.sh`: 9 of 9 fixtures pass.
  - Deviations: API paths are prefixed `/api/bg/` (for example `/api/bg/petitions/{id}/release`). Transactions use SQLite `BEGIN IMMEDIATE`, which locks the whole database instead of rows. Demo sessions are a persona picker; long-term private keys are non-extractable `CryptoKey` objects in this browser's IndexedDB, not passphrase-wrapped.
  - **Next:** 9.3 needs a person to print a card on paper and read it back. 10.3 needs the submission commit.

| Check | Where | Result in run 3 |
|---|---|---|
| T-01 | `service/tests/test_petitions.py`, `test_petition_machine.py` | pass |
| T-02 | `test_petitions.py::test_t02_route_inventory`, `test_t01_t02_…` | pass |
| T-03 | `test_t03_release_after_quorum…`, `test_t03_expiry_boundary` | pass |
| T-04 | `test_t04_…`, state machine | pass |
| T-05 | `test_t04_t05_closed_petitions_and_old_links…` (expire, deny, reseal); browser link reuse in `e2e/demos.spec.ts` (run 4) | pass |
| T-06 | `test_t06_split_approvals…`, state machine | pass |
| T-07 | `core-ts/test/shares.test.ts`, `release.test.ts`, `test_t07_t09_…` | pass |
| T-08 | `test_t08_write_once_columns` | pass |
| T-09 | `test_t07_t09_…`, state machine, ui-kit end-to-end | pass |
| T-10 | `core-ts/test/envelope.test.ts`, `test_t10_key_validation…` | pass |
| T-11 | `test_t11_eligibility`, `test_t11_concurrent_approvals…`, state machine | pass |
| T-12 | `core-ts/test/envelope.test.ts` (examples and fast-check) | pass |
| T-13 | `core-ts/test/release.test.ts` | pass |
| T-14 | `test_t14_no_material_in_logs`; browser test log scan | pass |
| T-15 | `test_t15_rotation_follow_up`; browser test | pass |
| AG-01 | screen rehearsal in `e2e/demos.spec.ts`; guide command checked from the root (run 4) | rehearsal only; gate pending (paper card) |
| AG-02 | `scripts/check-kiro-tracked.sh . HEAD` | rehearsal only; gate pending (public checkout of the submission commit) |

- **2026-11-07, run 2 (Kiro).** The shell tool failed every call at the permission step ("permission request failed before it was answered"), including `pwd`. No command ran: no `git init`, no `node`, no tests. File-only work done:
  - design.md: split the approver read path into `GET /petitions/{id}/approver-share` (D7); turned open questions into decisions D1 to D7; added guarantee labels GR-ROT and GR-LOG, rotation copy (section 8), gate dependency table.
  - Added `docs/acceptance/AG-01-printed-card.md`, `docs/acceptance/AG-02-committed-kiro.md`, `.kiro/required-files.txt`, `scripts/check-kiro-tracked.sh`, root `.gitignore` (does not ignore `.kiro/`).
  - Added `core-ts` slice for tasks 1.1 to 1.3: `src/bytes.ts`, `src/keys.ts`, `src/envelope.ts`, `test/envelope.test.ts`. Written, not run.
  - **Next task:** 0.1 (`git init`, first commit), then run `cd core-ts && npm test` for 1.1 to 1.3. Fix anything that fails before starting task 2.
- **2026-11-06, run 1 (Kiro).** Drafted design.md and tasks.md for review.

## Tasks

- [x] 0. M0 contract closure
- [x] 0.1 Initialise local Git with `.kiro/` tracked and unignored
  - `git init -b main`; commit the owner's files unchanged plus this spec; run `scripts/check-kiro-tracked.sh . HEAD` as a rehearsal and record the output here.
  - Done in commit 6136333 (local Kiro CLI run). Rehearsal re-run in run 3 on 12300a0: `AG-02 PASS (5 required files, 14 paths checked for ignore rules)`.
  - _Requirements: AG-02_
  - _Checks: AG-02 rehearsal_
- [x] 0.2 Resolve the status-versus-share inconsistency in design.md
  - `GET /petitions/{id}` is status only; eligible approvers use `GET /petitions/{id}/approver-share` for their own blob (design section 3, decision D7). Doc change, reviewed against BG-01.1; no code check applies.
  - _Requirements: BG-01.1, BG-03.2_
- [x] 0.3 Record decisions D1 to D7 in design.md
  - Doc change; draft defaults kept where compatible with the guarantees.
  - _Requirements: BG-01.2, BG-01.3, BG-03.2, GR-ROT, AG-02_

- [x] 1. Associated data and approval envelope in `core-ts`
- [x] 1.1 Implement canonical AAD encoding in `core-ts/src/envelope.ts`
  - Domain tag `coven/v1/approval`, length-prefixed UTF-8 fields, raw 32-byte fingerprint, six fields in the order fixed by the design.
  - Tests: known-answer vector, injectivity across field boundaries, fast-check injectivity over random bindings (`core-ts/test/envelope.test.ts`).
  - _Requirements: BG-03.3_
  - _Checks: T-12_
- [x] 1.2 Implement ephemeral key generation, validation and fingerprint in `core-ts/src/keys.ts`
  - Non-extractable P-256 ECDH key pair; 65-byte uncompressed export of the public key; on-curve validation on import; fingerprint = SHA-256 of the encoding.
  - _Requirements: BG-03.1_
  - _Checks: T-10_
- [x] 1.3 Implement `sealApproval` and `openApproval`, plus `sealApproverShare` and `openApproverShare`
  - Envelope v1: version byte, approver ephemeral key, nonce, AES-256-GCM ciphertext. ECDH plus HKDF-SHA-256 with salt = fingerprint.
  - Tests: each of the five string fields, the requester key and every ciphertext bit, plus a fast-check property over random bindings.
  - _Requirements: BG-03.3, BG-03.4_
  - _Checks: T-12_

- [x] 2. Seal versions
- [x] 2.1 Implement browser sealing and resealing
  - Fresh random item key per version; client-chosen UUIDv4 `seal_version_id`; header AAD binds `item_id` and `seal_version_id`; new share set per version, each share sealed with `sealApproverShare`.
  - _Requirements: BG-02.1, BG-02.4_
  - _Checks: T-07_
- [x] 2.2 Implement `SealVersion` storage and `activate_seal_version` in `service/coven_service/petitions.py`
  - Immutable version rows; reject reused version IDs; one transaction sets the current version, moves old-version petitions to `Invalidated` and appends record events.
  - _Requirements: BG-02.1, BG-02.3_
  - _Checks: T-09_
- [x] 2.3 Write cross-version tests
  - Old item key, old shares and old envelopes all fail the new version's header check. Old approvals count zero on a new-version petition.
  - _Requirements: BG-02.3, BG-02.4_
  - _Checks: T-07, T-09_

- [x] 3. Petition creation
- [x] 3.1 Implement `POST /petitions`
  - Requester identity from the session only; reject extra fields; validate the public key with `from_encoded_point`; bind the current seal version and `expires_at = now + min(requested, 3600)` in one transaction; store the fingerprint.
  - _Requirements: BG-02.2, BG-03.1_
  - _Checks: T-08, T-10_
- [x] 3.2 Enforce write-once petition columns
  - No update path in the repository layer; a database trigger rejects updates to the bound columns.
  - _Requirements: BG-02.2, BG-03.1_
  - _Checks: T-08_
- [x] 3.3 Implement requester key storage in the browser
  - Store the `CryptoKey` in IndexedDB by `petition_id`; show the locally computed fingerprint; delete the key after local decryption or when the petition is terminal.
  - _Requirements: BG-03.1_
  - _Checks: T-10_

- [x] 4. Approver enrollment and approval
- [x] 4.1 Implement approver key enrollment
  - Bind the validated long-term public key to the authenticated account.
  - _Requirements: BG-03.2_
  - _Checks: T-11_
- [x] 4.2 Implement `GET /petitions/{id}/approver-share`
  - Eligible approvers for the version only (404 otherwise); 409 unless `Open`, current and before expiry; returns only the caller's own blob plus status fields.
  - _Requirements: BG-01.1, BG-03.2_
  - _Checks: T-02, T-11_
- [x] 4.3 Implement `POST /petitions/{id}/approvals`
  - Locked transaction with the checks in design section 3; unique `(petition_id, approver_id)`; idempotent repeats; move to `Approved` at k; reject later approvals.
  - _Requirements: BG-03.2, BG-01.4_
  - _Checks: T-06, T-11_
- [x] 4.4 Implement the approver client flow
  - Call `/approver-share`; validate the key and compute the fingerprint locally; open own blob; seal with the six-field AAD; upload.
  - _Requirements: BG-03.3_
  - _Checks: T-12_
- [x] 4.5 Write the concurrency test
  - Parallel duplicate approvals from one identity count once; parallel approvals from distinct identities stop at exactly k stored envelopes.
  - _Requirements: BG-03.2, BG-01.4_
  - _Checks: T-11, T-06_
- [x] 4.6 Implement deny
  - Eligible approver or item administrator; `Open` or `Approved` to `Denied` (decision D2).
  - _Requirements: BG-01.3_
  - _Checks: T-04_

- [x] 5. Release decision
- [x] 5.1 Implement `release_decision` and `GET /petitions/{id}/release`
  - One transaction with row locks on petition and item; the five conditions from design section 5 read in that transaction; `Cache-Control: no-store`; first success moves to `Released` and sets `rotation_required`.
  - _Requirements: BG-01.2, GR-ROT_
  - _Checks: T-03, T-15_
- [x] 5.2 Implement rejection paths
  - 404 for a non-requester; 409 below quorum; 410 for denied, invalidated or expired; expiry evaluated at decision time with `now >= expires_at` rejecting; no material read before the checks pass.
  - _Requirements: BG-01.1, BG-01.3_
  - _Checks: T-03, T-04, T-05_
- [x] 5.3 Implement the status endpoint `GET /petitions/{id}`
  - Status fields only (design section 3 table).
  - _Requirements: BG-01.1_
  - _Checks: T-01, T-02_
- [x] 5.4 Write the endpoint inventory test
  - Scan the route table and response schemas; only `/release` may return item ciphertext, header or envelopes; `/approver-share` returns only the caller's blob; no static or blob URLs.
  - _Requirements: BG-01.1_
  - _Checks: T-02_

- [x] 6. Requester client verification and decryption
- [x] 6.1 Implement package verification in the requester client
  - Rebuild AAD from the local petition record; reject duplicate approver IDs, fewer than k envelopes, GCM failures and duplicate share indices; pass only verified shares to `combine`.
  - _Requirements: BG-03.4_
  - _Checks: T-13_
- [x] 6.2 Combine, check the header, then decrypt the item
  - Decrypt the item only after the version header check passes.
  - _Requirements: BG-02.4, BG-03.4_
  - _Checks: T-07, T-13_

- [x] 7. Petition lifecycle and rotation
- [x] 7.1 Implement the state machine with terminal `Expired`, `Denied` and `Invalidated`
  - Transitions as drawn in design section 7; record events with IDs, states, counts and fingerprint only.
  - _Requirements: BG-01.3, BG-02.3_
  - _Checks: T-04, T-09_
- [x] 7.2 Write the Hypothesis `RuleBasedStateMachine` for petitions
  - Rules: create, approve (eligible, ineligible, repeat), deny, reseal, advance clock, retrieve as requester and as another user, fetch approver share. Invariants: no material below quorum or from a terminal state; no transition out of a terminal state; count equals distinct eligible approvers.
  - _Requirements: BG-01.1, BG-01.3, BG-01.4, BG-02.3, BG-03.2_
  - _Checks: T-01, T-04, T-06, T-09, T-11_
- [x] 7.3 Write the old-link test
  - Save a petition URL; after expiry, denial and reseal, the requester gets no material from it; another authenticated user gets 404 at every stage.
  - _Requirements: BG-01.3_
  - _Checks: T-05_
- [x] 7.4 Implement rotation confirmation and release-screen copy
  - `POST /items/{id}/rotation-confirmed`; release screen uses the design section 8 sentence verbatim.
  - _Requirements: GR-ROT_
  - _Checks: T-15_

- [x] 8. Logging boundary
- [x] 8.1 Add the per-route log field allowlist
  - Exclude approval request bodies and release and approver-share response bodies from access logs, error reports and traces.
  - _Requirements: GR-LOG_
  - _Checks: T-14_
- [x] 8.2 Write the log capture test
  - Run a full petition through release; scan captured logs for envelope, blob and ciphertext bytes in hex and base64.
  - _Requirements: GR-LOG_
  - _Checks: T-14_

- [ ] 9. Acceptance gate AG-01: define in M0, run in M2
- [x] 9.1 Write `docs/acceptance/AG-01-printed-card.md`
  - Procedure, dependencies (physical printer, person reading paper, M2 recovery flow), evidence and pass rule. Doc task; no code check applies.
  - _Requirements: AG-01_
- [x] 9.2 Write the capture scanner `scripts/scan-capture.mjs` with a self-test on fictional data
  - Search for raw share bytes (hex, base64, base64url), the `coven1:` payload, and the word code with and without separators in any case. Exit non-zero on any match. Print only file and offset.
  - `node scripts/scan-capture.mjs --self-test`: PASS (7 leak forms detected, clean capture clean).
  - _Requirements: AG-01_
- [ ] 9.3 Run AG-01 with a physical printed card when the Last Light recovery flow exists, and record the result
  - Recovery flow now exists. Screen rehearsal passed in run 3 (see progress log); it is not a pass.
  - Run 5 (2026-11-07): capture done for run-20261107 on code commit 7665e0d. Fresh isolated stack; card PDF (Bram, receipt at issuance `7:5a7be605fdb965c1f9c668fec6c5eb6dd1011adfa0d2514ad9944697f66a11d2`) and bundle exported. Stack stopped and confirmed unreachable. Scanner: no match in HAR (55 entries), service logs or bundle. **Pending:** paper print and read-back by the person, then `scripts/ag01-offline.sh`.
  - Blocked on: a person printing a card on paper and reading it back.
  - _Requirements: AG-01_

- [ ] 10. Acceptance gate AG-02: define in M0, run on the submission commit
- [x] 10.1 Write `scripts/check-kiro-tracked.sh` and `.kiro/required-files.txt`
  - Rehearsal passes (see 0.1).
  - _Requirements: AG-02_
- [x] 10.1a Write `docs/acceptance/AG-02-committed-kiro.md`
  - Doc task; no code check applies.
  - _Requirements: AG-02_
- [x] 10.2 Add a fixture test for the script
  - A temporary repository where `.gitignore` ignores an already tracked `.kiro/` file must FAIL; a clean one must PASS.
  - `scripts/test-check-kiro-tracked.sh`: 9 fixtures pass (2 PASS cases, 7 FAIL cases).
  - _Requirements: AG-02_
- [ ] 10.3 Run AG-02 on the submission commit and record the SHA and result
  - Blocked on: the final submission commit (M5).
  - _Requirements: AG-02_

## Traceability

| Requirement | Tasks | Checks |
|---|---|---|
| BG-01.1 | 0.2, 4.2, 5.2, 5.3, 5.4, 7.2 | T-01, T-02 |
| BG-01.2 | 0.3, 5.1 | T-03 |
| BG-01.3 | 0.3, 4.6, 5.2, 7.1, 7.2, 7.3 | T-03, T-04, T-05 |
| BG-01.4 | 4.3, 4.5, 7.2 | T-06 |
| BG-02.1 | 2.1, 2.2 | T-07 |
| BG-02.2 | 3.1, 3.2 | T-08 |
| BG-02.3 | 2.2, 2.3, 7.1, 7.2 | T-09 |
| BG-02.4 | 2.1, 2.3, 6.2 | T-07 |
| BG-03.1 | 1.2, 3.1, 3.2, 3.3 | T-08, T-10 |
| BG-03.2 | 0.2, 0.3, 4.1, 4.2, 4.3, 4.5, 7.2 | T-11 |
| BG-03.3 | 1.1, 1.3, 4.4 | T-12 |
| BG-03.4 | 1.3, 6.1, 6.2 | T-12, T-13 |
| AG-01 | 9.1, 9.2, 9.3 | AG-01 gate run |
| AG-02 | 0.1, 0.3, 10.1, 10.1a, 10.2, 10.3 | AG-02 rehearsal, AG-02 gate run |
| GR-ROT | 0.3, 5.1, 7.4 | T-15 |
| GR-LOG | 8.1, 8.2 | T-14 |
