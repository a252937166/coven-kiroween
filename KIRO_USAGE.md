# Kiro usage evidence

Only what was actually used is listed. Each entry points to a committed artifact. A test is called passing only when the run that passed it is named.

## Specs

- Spec 05 `petition-lifecycle-and-binding`: the owner wrote `requirements.md`. Kiro drafted `design.md` and `tasks.md` (2026-11-06), then revised the design to split the approver share endpoint and record decisions D1 to D7 (2026-11-07, run 2).
  - Artifacts: `.kiro/specs/05-petition-lifecycle-and-binding/`
  - Run 3 (2026-11-07, Kiro in Kiro Crew) implemented tasks 1 to 8 and 9.2 against the spec and recorded each check's result in the `tasks.md` progress log.
  - Run 4 (2026-11-07, same session) closed a review pass from 87b5879: scenario 3 in the browser, U+007F parity, the records snapshot, Last Light release wording and retry, and the AG-01 command. Evidence is in the run 4 entry of the `tasks.md` progress log.

### Requirement → design → code → verified behavior

| Requirement | Design | Code | Check that passed (run 3) |
|---|---|---|---|
| BG-03.3 six-field binding | section 4 | `core-ts/src/envelope.ts` `encodeApprovalAad`, `sealApproval` | T-12 in `core-ts/test/envelope.test.ts`, including a fast-check property: changing any one field fails |
| BG-01.4 no pooling across petitions | section 3 | `service/coven_service/petitions.py` `approve`, `release` | T-06 in `service/tests/test_petitions.py`; Hypothesis state machine in `test_petition_machine.py` |
| BG-01.2 one release decision | section 5 | `petitions.release` | T-03; a planted bug (quorum check removed) made the state machine fail, then it was restored |
| BG-02.3 reseal invalidates | section 1 | `petitions.activate_seal_version` | T-09; ui-kit end-to-end test |
| BG-03.4 client rejects foreign envelopes | section 6 | `core-ts/src/release.ts` `openRelease` | T-13 in `core-ts/test/release.test.ts` |
| GR-ROT rotation and window copy | section 8 | `petitions.ROTATION_COPY`, Break Glass release screen | T-15; Playwright test `e2e/demos.spec.ts` |
| BG-01.3 issued link refused after expiry (scenario 3) | section 5 | `petitionLink`, `LinkView` in `apps/break-glass`, `petitions.release` | Run 4: Playwright reuses a link with a local key and valid session; 410 after expiry, 404 for an ineligible user; fails when the release-time expiry check is removed |
| Invariant 9 record hashing across languages | proposal 3.4 | `core-ts/src/records.ts` `canonicalJson`, `service/coven_service/common.py` | Run 4: `fixtures/record-vectors.json` asserted by both suites; the old U+007F handling fails it |

## Surfaces

- Kiro CLI (local session): the run that created commit 6136333 (spec decisions, AG gate docs and scripts, first envelope slice), as reported by the owner.
- Kiro in Kiro Crew (local session): runs 1, 3 and 4, which drafted the spec, built the code after 6136333 and closed the review pass.

## UI redesign (run 6)

- Kiro redesigned both apps from design notes the owner supplied via Codex: an artifact-led hero, one permitted next action per role, and outcomes first with evidence on demand. Evidence: `scripts/print-geometry.ts` (printed card unchanged), `scripts/screenshots.ts` and `docs/screenshots/`, and the run 6 entry of the `tasks.md` progress log.

- Run 7: Kiro fixed role-isolation edge cases found on independent review: a role epoch, keyed role-scoped panels, and plaintext bound to the requester. Each fix has a held-response browser check, plus a mutation run showing the check fails without the fix (`tasks.md`, run 7).

## Steering

- `.kiro/steering/guarantees.md` (owner-written, `inclusion: always`) shaped the design and the app copy: retrieval-window wording, "a missed check-in is a signal, not proof of death", routing labels, online-only earliest dates, and the offline-recovery statement on the Last Light screen and in `README.md`.

## Property-based testing

- TypeScript: fast-check properties in `core-ts/test/shares.test.ts` (any k shares rebuild; wrong, foreign, duplicate or short shares fail; word-code checksum catches every single-symbol change and adjacent swap) and `core-ts/test/envelope.test.ts`. Written by Kiro; 35 of 35 core tests passed in run 3 and 40 of 40 in run 4.
- Python: Hypothesis `RuleBasedStateMachine` for petitions and a receipt-outcome property, in `service/tests/`. Written by Kiro; 28 of 28 service tests passed in run 3 and 32 of 32 in run 4. These ran with pytest from the agent shell, not through the IDE's property-based testing feature.

## Acceptance evidence

| Gate | Status | Evidence |
|---|---|---|
| AG-01 Printed card | **Passed 2026-11-08** (run-20261107). The owner printed Bram's fictional card on paper and typed the word code from it. The read-back matched; three shares opened the vault offline, with the isolated service unreachable; the scanner found no share in the HAR, logs, bundle or CLI output. Card from commit `7665e0d`. Redacted record in `docs/acceptance/AG-01-printed-card.md`. A redacted card photo has not been provided. | physical pass |
| AG-02 Committed `.kiro/` | `scripts/check-kiro-tracked.sh . HEAD` passes on local commit 12300a0; 9 of 9 ignore fixtures pass. **Pending:** needs a clean public checkout of the submission commit. | rehearsal only |

## Not yet used

Hooks, custom agents, MCP servers, powers, Kiro CLI headless runs in CI, and the IDE's spec-driven task execution are planned in `PROPOSAL.md` section 6 and have not been used yet. Specs 01 to 04 and 06 to 12 have not been written; their features were built from `PROPOSAL.md` sections 3 and 4.
