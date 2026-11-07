# AG-02 Committed Kiro artifacts

Source: [spec 05 requirements, AG-02](../../.kiro/specs/05-petition-lifecycle-and-binding/requirements.md), the acceptance-evidence section of [guarantees.md](../../.kiro/steering/guarantees.md), and the [Kiroween Official Rules](https://kiroween.devpost.com/rules).

Status: **defined in M0.** The script can run on any local commit as a rehearsal. The gate passes only on the final submission commit (M5).

## What it proves

From a clean checkout of one commit:

1. `.kiro/` is at the repository root.
2. Every path in `.kiro/required-files.txt` exists and is tracked in that commit.
3. No ignore rule matches `.kiro/`, any of its subdirectories, or any required file. Rules are evaluated even for tracked files (`git check-ignore --no-index`).

## Dependencies

| Dependency | Why |
|---|---|
| The submission commit | The evidence must name the commit judges see. A local rehearsal is not the gate. |
| `.kiro/required-files.txt` kept current | It must list this spec, `guarantees.md`, and every artifact `KIRO_USAGE.md` cites. |

## Procedure

```
scripts/check-kiro-tracked.sh <repo-path-or-url> <commit>
```

The script clones into a fresh temporary directory, checks out the commit, runs the three checks, prints the commit SHA and `AG-02 PASS` or `AG-02 FAIL` with each failing path, and exits non-zero on failure.

## Evidence to keep

The full script output, including the SHA. Record it in `KIRO_USAGE.md` under "Acceptance evidence".
