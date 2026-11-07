# Kiro usage evidence

Only what was actually used is listed. Each entry points to a committed artifact. Nothing here claims a test passed unless the run is named.

## Specs

- Spec 05 `petition-lifecycle-and-binding`: the owner wrote `requirements.md`. Kiro drafted `design.md` and `tasks.md` (2026-11-06), then revised the design to split the approver share endpoint and record decisions D1 to D7 (2026-11-07).
  - Artifacts: `.kiro/specs/05-petition-lifecycle-and-binding/`
  - Chain started: BG-03.3 → design section 4 → `core-ts/src/envelope.ts` `encodeApprovalAad` / `sealApproval` → check T-12 in `core-ts/test/envelope.test.ts`. **Verification pending:** the test has not run yet.

## Steering

- `.kiro/steering/guarantees.md` (owner-written, `inclusion: always`) shaped the design: retrieval-window copy (design section 8), log boundary (section 9), no release material on status paths (section 3).

## Acceptance evidence

| Gate | Status | Evidence |
|---|---|---|
| AG-01 Printed card | Defined in `docs/acceptance/AG-01-printed-card.md`. Not run: needs the M2 recovery flow and a physical printed card. | none yet |
| AG-02 Committed `.kiro/` | Defined in `docs/acceptance/AG-02-committed-kiro.md`; script `scripts/check-kiro-tracked.sh`. Not run: Git not initialised yet; the gate needs the submission commit. | none yet |

## Not yet used

Hooks, custom agents, MCP servers, powers, property-based testing and CLI headless runs are planned in `PROPOSAL.md` section 6 but have not been used yet.
