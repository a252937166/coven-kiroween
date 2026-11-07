#!/usr/bin/env bash
# Fixture tests for scripts/check-kiro-tracked.sh (spec 05 task 10.2).
# Builds throwaway repositories under $TMPDIR with fictional content and checks
# that the gate passes or fails as expected.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
gate="$here/check-kiro-tracked.sh"
root="$(mktemp -d "${TMPDIR:-/tmp}/ag02fx.XXXXXX")"
trap 'rm -rf "$root"' EXIT

pass=0
fail=0

gitc() { git -c user.name=fixture -c user.email=fixture@example.test -c init.defaultBranch=main "$@"; }

# new_repo <name>: a repo with a manifest and two required files, not yet committed.
new_repo() {
  local r="$root/$1"
  mkdir -p "$r/.kiro/specs/demo" "$r/.kiro/steering"
  gitc -C "$r" init -q
  printf '# manifest\n.kiro/required-files.txt\n.kiro/steering/guarantees.md\n.kiro/specs/demo/requirements.md\n' \
    > "$r/.kiro/required-files.txt"
  echo "fictional steering" > "$r/.kiro/steering/guarantees.md"
  echo "fictional spec" > "$r/.kiro/specs/demo/requirements.md"
  echo "$r"
}

commit_all() { gitc -C "$1" add -A && gitc -C "$1" commit -qm fixture; }

# expect <PASS|FAIL> <name> <repo> [grep pattern that must appear in output]
expect() {
  local want="$1" name="$2" repo="$3" pattern="${4:-}" out status got
  set +e
  out="$("$gate" "$repo" HEAD 2>&1)"
  status=$?
  set -e
  if (( status == 0 )); then got=PASS; else got=FAIL; fi
  if [[ "$got" == "$want" ]] && { [[ -z "$pattern" ]] || grep -q -- "$pattern" <<<"$out"; }; then
    echo "ok   $name ($got)"
    pass=$((pass + 1))
  else
    echo "FAIL $name: wanted $want${pattern:+ with '$pattern'}, got $got"
    sed 's/^/     /' <<<"$out"
    fail=$((fail + 1))
  fi
}

# Positive: negated rules like the project's own .gitignore must NOT count as ignored.
r="$(new_repo pos-negated)"
printf 'node_modules/\n*.local.txt\n!.kiro/\n!.kiro/**\n' > "$r/.gitignore"
commit_all "$r"
expect PASS "negated !.kiro rules are not ignores" "$r"

# Positive: no .gitignore at all.
r="$(new_repo pos-plain)"
commit_all "$r"
expect PASS "no ignore rules" "$r"

# Negative: a tracked required file is matched by an ignore rule added after it was tracked.
r="$(new_repo neg-tracked-ignored)"
commit_all "$r"
printf '.kiro/specs/demo/requirements.md\n' > "$r/.gitignore"
commit_all "$r"
expect FAIL "tracked file later ignored" "$r" "ignored: .kiro/specs/demo/requirements.md"

# Negative: the whole .kiro directory is ignored, but files were force-added.
r="$(new_repo neg-dir-ignored)"
printf '.kiro/\n' > "$r/.gitignore"
gitc -C "$r" add -f .kiro .gitignore && gitc -C "$r" commit -qm fixture
expect FAIL ".kiro/ directory ignored" "$r" "ignored: .kiro/"

# Negative: a subdirectory is ignored by a glob.
r="$(new_repo neg-subdir-ignored)"
printf 'steering/\n' > "$r/.gitignore"
gitc -C "$r" add -f .kiro .gitignore && gitc -C "$r" commit -qm fixture
expect FAIL "subdirectory ignored" "$r" "ignored: .kiro/steering/"

# Negative: a later rule re-ignores after a negation.
r="$(new_repo neg-reignored)"
printf '!.kiro/**\n*.md\n' > "$r/.gitignore"
gitc -C "$r" add -f .kiro .gitignore && gitc -C "$r" commit -qm fixture
expect FAIL "later rule re-ignores after negation" "$r" "ignored: .kiro/steering/guarantees.md"

# Negative: a nested .gitignore inside .kiro ignores a file.
r="$(new_repo neg-nested-ignore)"
printf 'guarantees.md\n' > "$r/.kiro/steering/.gitignore"
gitc -C "$r" add -f .kiro && gitc -C "$r" commit -qm fixture
expect FAIL "nested .gitignore inside .kiro" "$r" "ignored: .kiro/steering/guarantees.md"

# Negative: a required file is missing from the commit.
r="$(new_repo neg-missing)"
rm "$r/.kiro/specs/demo/requirements.md"
commit_all "$r"
expect FAIL "required file missing" "$r" "missing: .kiro/specs/demo/requirements.md"

# Negative: .kiro absent entirely.
r="$root/neg-no-kiro"
mkdir -p "$r" && gitc -C "$r" init -q && echo readme > "$r/README.md"
commit_all "$r"
expect FAIL ".kiro missing at root" "$r" ".kiro/ missing"

echo "fixtures: $pass passed, $fail failed"
(( fail == 0 ))
