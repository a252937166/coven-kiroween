# Implementation Plan

Each task lists the requirement IDs (or guarantee labels GR-ROT, GR-LOG from design.md) it serves and the checks from [design.md](design.md) "Testing Strategy" that verify it. Write each check before or with the code it verifies.

Status markers:

- `[x]` done: the listed check ran and passed. The progress log names the run.
- `[ ]` not done. A note "written, not run" means code or docs exist but no check has passed yet.

Tasks 0, 9 and 10 are M0. Tasks 1 to 8 are M1 and M3.

## Progress log

Newest first. Another run resumes from the first entry.

- **2026-11-07, run 2 (Kiro).** The shell tool failed every call at the permission step ("permission request failed before it was answered"), including `pwd`. No command ran: no `git init`, no `node`, no tests. File-only work done:
  - design.md: split the approver read path into `GET /petitions/{id}/approver-share` (D7); turned open questions into decisions D1 to D7; added guarantee labels GR-ROT and GR-LOG, rotation copy (section 8), gate dependency table.
  - Added `docs/acceptance/AG-01-printed-card.md`, `docs/acceptance/AG-02-committed-kiro.md`, `.kiro/required-files.txt`, `scripts/check-kiro-tracked.sh`, root `.gitignore` (does not ignore `.kiro/`).
  - Added `core-ts` slice for tasks 1.1 to 1.3: `src/bytes.ts`, `src/keys.ts`, `src/envelope.ts`, `test/envelope.test.ts`. Written, not run.
  - **Next task:** 0.1 (`git init`, first commit), then run `cd core-ts && npm test` for 1.1 to 1.3. Fix anything that fails before starting task 2.
- **2026-11-06, run 1 (Kiro).** Drafted design.md and tasks.md for review.

## Tasks

- [ ] 0. M0 contract closure
- [ ] 0.1 Initialise local Git with `.kiro/` tracked and unignored
  - `git init -b main`; commit the owner's files unchanged plus this spec; run `scripts/check-kiro-tracked.sh . HEAD` as a rehearsal and record the output here.
  - Note: root `.gitignore` written, it ends with `!.kiro/` and `!.kiro/**`. Git not yet initialised (shell unavailable in run 2).
  - _Requirements: AG-02_
  - _Checks: AG-02 rehearsal_
- [x] 0.2 Resolve the status-versus-share inconsistency in design.md
  - `GET /petitions/{id}` is status only; eligible approvers use `GET /petitions/{id}/approver-share` for their own blob (design section 3, decision D7). Doc change, reviewed against BG-01.1; no code check applies.
  - _Requirements: BG-01.1, BG-03.2_
- [x] 0.3 Record decisions D1 to D7 in design.md
  - Doc change; draft defaults kept where compatible with the guarantees.
  - _Requirements: BG-01.2, BG-01.3, BG-03.2, GR-ROT, AG-02_

- [ ] 1. Associated data and approval envelope in `core-ts`
- [ ] 1.1 Implement canonical AAD encoding in `core-ts/src/envelope.ts`
  - Domain tag `coven/v1/approval`, length-prefixed UTF-8 fields, raw 32-byte fingerprint, six fields in the order fixed by the design.
  - Tests: injectivity across field boundaries (in `test/envelope.test.ts`). Still to add: known-answer vectors; fast-check version.
  - Note: written, not run.
  - _Requirements: BG-03.3_
  - _Checks: T-12_
- [ ] 1.2 Implement ephemeral key generation, validation and fingerprint in `core-ts/src/keys.ts`
  - Non-extractable P-256 ECDH key pair; 65-byte uncompressed export of the public key; on-curve validation on import; fingerprint = SHA-256 of the encoding.
  - Note: written, not run.
  - _Requirements: BG-03.1_
  - _Checks: T-10_
- [ ] 1.3 Implement `sealApproval` and `openApproval`, plus `sealApproverShare` and `openApproverShare`
  - Envelope v1: version byte, approver ephemeral key, nonce, AES-256-GCM ciphertext. ECDH plus HKDF-SHA-256 with salt = fingerprint.
  - Tests: each of the five string fields, the requester key and every ciphertext bit. Still to add: fast-check version once `fast-check` is installed.
  - Note: written, not run.
  - _Requirements: BG-03.3, BG-03.4_
  - _Checks: T-12_

- [ ] 2. Seal versions
- [ ] 2.1 Implement browser sealing and resealing
  - Fresh random item key per version; client-chosen UUIDv4 `seal_version_id`; header AAD binds `item_id` and `seal_version_id`; new share set per version, each share sealed with `sealApproverShare`.
  - _Requirements: BG-02.1, BG-02.4_
  - _Checks: T-07_
- [ ] 2.2 Implement `SealVersion` storage and `activate_seal_version` in `service/coven_service/petitions.py`
  - Immutable version rows; reject reused version IDs; one transaction sets the current version, moves old-version petitions to `Invalidated` and appends record events.
  - _Requirements: BG-02.1, BG-02.3_
  - _Checks: T-09_
- [ ] 2.3 Write cross-version tests
  - Old item key, old shares and old envelopes all fail the new version's header check. Old approvals count zero on a new-version petition.
  - _Requirements: BG-02.3, BG-02.4_
  - _Checks: T-07, T-09_

- [ ] 3. Petition creation
- [ ] 3.1 Implement `POST /petitions`
  - Requester identity from the session only; reject extra fields; validate the public key with `from_encoded_point`; bind the current seal version and `expires_at = now + min(requested, 3600)` in one transaction; store the fingerprint.
  - _Requirements: BG-02.2, BG-03.1_
  - _Checks: T-08, T-10_
- [ ] 3.2 Enforce write-once petition columns
  - No update path in the repository layer; a database trigger rejects updates to the bound columns.
  - _Requirements: BG-02.2, BG-03.1_
  - _Checks: T-08_
- [ ] 3.3 Implement requester key storage in the browser
  - Store the `CryptoKey` in IndexedDB by `petition_id`; show the locally computed fingerprint; delete the key after local decryption or when the petition is terminal.
  - _Requirements: BG-03.1_
  - _Checks: T-10_

- [ ] 4. Approver enrollment and approval
- [ ] 4.1 Implement approver key enrollment
  - Bind the validated long-term public key to the authenticated account.
  - _Requirements: BG-03.2_
  - _Checks: T-11_
- [ ] 4.2 Implement `GET /petitions/{id}/approver-share`
  - Eligible approvers for the version only (404 otherwise); 409 unless `Open`, current and before expiry; returns only the caller's own blob plus status fields.
  - _Requirements: BG-01.1, BG-03.2_
  - _Checks: T-02, T-11_
- [ ] 4.3 Implement `POST /petitions/{id}/approvals`
  - Locked transaction with the checks in design section 3; unique `(petition_id, approver_id)`; idempotent repeats; move to `Approved` at k; reject later approvals.
  - _Requirements: BG-03.2, BG-01.4_
  - _Checks: T-06, T-11_
- [ ] 4.4 Implement the approver client flow
  - Call `/approver-share`; validate the key and compute the fingerprint locally; open own blob; seal with the six-field AAD; upload.
  - _Requirements: BG-03.3_
  - _Checks: T-12_
- [ ] 4.5 Write the concurrency test
  - Parallel duplicate approvals from one identity count once; parallel approvals from distinct identities stop at exactly k stored envelopes.
  - _Requirements: BG-03.2, BG-01.4_
  - _Checks: T-11, T-06_
- [ ] 4.6 Implement deny
  - Eligible approver or item administrator; `Open` or `Approved` to `Denied` (decision D2).
  - _Requirements: BG-01.3_
  - _Checks: T-04_

- [ ] 5. Release decision
- [ ] 5.1 Implement `release_decision` and `GET /petitions/{id}/release`
  - One transaction with row locks on petition and item; the five conditions from design section 5 read in that transaction; `Cache-Control: no-store`; first success moves to `Released` and sets `rotation_required`.
  - _Requirements: BG-01.2, GR-ROT_
  - _Checks: T-03, T-15_
- [ ] 5.2 Implement rejection paths
  - 404 for a non-requester; 409 below quorum; 410 for denied, invalidated or expired; expiry evaluated at decision time with `now >= expires_at` rejecting; no material read before the checks pass.
  - _Requirements: BG-01.1, BG-01.3_
  - _Checks: T-03, T-04, T-05_
- [ ] 5.3 Implement the status endpoint `GET /petitions/{id}`
  - Status fields only (design section 3 table).
  - _Requirements: BG-01.1_
  - _Checks: T-01, T-02_
- [ ] 5.4 Write the endpoint inventory test
  - Scan the route table and response schemas; only `/release` may return item ciphertext, header or envelopes; `/approver-share` returns only the caller's blob; no static or blob URLs.
  - _Requirements: BG-01.1_
  - _Checks: T-02_

- [ ] 6. Requester client verification and decryption
- [ ] 6.1 Implement package verification in the requester client
  - Rebuild AAD from the local petition record; reject duplicate approver IDs, fewer than k envelopes, GCM failures and duplicate share indices; pass only verified shares to `combine`.
  - _Requirements: BG-03.4_
  - _Checks: T-13_
- [ ] 6.2 Combine, check the header, then decrypt the item
  - Decrypt the item only after the version header check passes.
  - _Requirements: BG-02.4, BG-03.4_
  - _Checks: T-07, T-13_

- [ ] 7. Petition lifecycle and rotation
- [ ] 7.1 Implement the state machine with terminal `Expired`, `Denied` and `Invalidated`
  - Transitions as drawn in design section 7; record events with IDs, states, counts and fingerprint only.
  - _Requirements: BG-01.3, BG-02.3_
  - _Checks: T-04, T-09_
- [ ] 7.2 Write the Hypothesis `RuleBasedStateMachine` for petitions
  - Rules: create, approve (eligible, ineligible, repeat), deny, reseal, advance clock, retrieve as requester and as another user, fetch approver share. Invariants: no material below quorum or from a terminal state; no transition out of a terminal state; count equals distinct eligible approvers.
  - _Requirements: BG-01.1, BG-01.3, BG-01.4, BG-02.3, BG-03.2_
  - _Checks: T-01, T-04, T-06, T-09, T-11_
- [ ] 7.3 Write the old-link test
  - Save a petition URL; after expiry, denial and reseal, the requester gets no material from it; another authenticated user gets 404 at every stage.
  - _Requirements: BG-01.3_
  - _Checks: T-05_
- [ ] 7.4 Implement rotation confirmation and release-screen copy
  - `POST /items/{id}/rotation-confirmed`; release screen uses the design section 8 sentence verbatim.
  - _Requirements: GR-ROT_
  - _Checks: T-15_

- [ ] 8. Logging boundary
- [ ] 8.1 Add the per-route log field allowlist
  - Exclude approval request bodies and release and approver-share response bodies from access logs, error reports and traces.
  - _Requirements: GR-LOG_
  - _Checks: T-14_
- [ ] 8.2 Write the log capture test
  - Run a full petition through release; scan captured logs for envelope, blob and ciphertext bytes in hex and base64.
  - _Requirements: GR-LOG_
  - _Checks: T-14_

- [ ] 9. Acceptance gate AG-01: define in M0, run in M2
- [x] 9.1 Write `docs/acceptance/AG-01-printed-card.md`
  - Procedure, dependencies (physical printer, person reading paper, M2 recovery flow), evidence and pass rule. Doc task; no code check applies.
  - _Requirements: AG-01_
- [ ] 9.2 Write the capture scanner `scripts/scan-capture.mjs` with a self-test on fictional data
  - Search for raw share bytes (hex, base64, base64url), the `coven1:` payload, and the word code with and without separators in any case. Exit non-zero on any match. Print only file and offset.
  - _Requirements: AG-01_
- [ ] 9.3 Run AG-01 with a physical printed card when the Last Light recovery flow exists, and record the result
  - Blocked on: M2 recovery flow; physical printing by a person.
  - _Requirements: AG-01_

- [ ] 10. Acceptance gate AG-02: define in M0, run on the submission commit
- [ ] 10.1 Write `scripts/check-kiro-tracked.sh` and `.kiro/required-files.txt`
  - Both written. Note: written, not run. Done when the rehearsal in 0.1 passes.
  - _Requirements: AG-02_
- [x] 10.1a Write `docs/acceptance/AG-02-committed-kiro.md`
  - Doc task; no code check applies.
  - _Requirements: AG-02_
- [ ] 10.2 Add a fixture test for the script
  - A temporary repository where `.gitignore` ignores an already tracked `.kiro/` file must FAIL; a clean one must PASS.
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
