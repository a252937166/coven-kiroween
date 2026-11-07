#!/usr/bin/env bash
# AG-02: verify that root .kiro/ and its required files are present, tracked and unignored
# in a clean checkout of one commit. See docs/acceptance/AG-02-committed-kiro.md.
#
# Usage: scripts/check-kiro-tracked.sh <repo-path-or-url> [commit]
#
# Ignored status is decided by `git check-ignore --no-index -q` exit status only.
# `-v` is NOT used for the decision: with -v, git reports the last matching pattern
# even when it is a negation such as `!.kiro/**`, and exits 0. -v output is printed
# only as a diagnostic for paths already found to be ignored.
#
# The user's global excludes file is disabled (core.excludesFile=/dev/null) so the
# result depends only on rules committed in the repository, as a judge's clean
# checkout would see them.
set -euo pipefail

repo="${1:?usage: check-kiro-tracked.sh <repo-path-or-url> [commit]}"
commit="${2:-HEAD}"

work="$(mktemp -d "${TMPDIR:-/tmp}/ag02.XXXXXX")"
trap 'rm -rf "$work"' EXIT

git clone --quiet --no-checkout "$repo" "$work/repo"
cd "$work/repo"
git -c advice.detachedHead=false checkout --quiet "$commit"
sha="$(git rev-parse HEAD)"

g() { git -c core.excludesFile=/dev/null "$@"; }

failures=()

if [[ ! -d .kiro ]]; then
  failures+=(".kiro/ missing at repository root")
fi

manifest=".kiro/required-files.txt"
required=()
if [[ -f "$manifest" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    line="$(printf '%s' "$line" | sed -e 's/[[:space:]]*$//' -e 's/^[[:space:]]*//')"
    [[ -n "$line" ]] && required+=("$line")
  done < "$manifest"
else
  failures+=("$manifest missing")
fi

for path in "${required[@]+"${required[@]}"}"; do
  if [[ ! -e "$path" ]]; then
    failures+=("missing: $path")
  elif ! g ls-files --error-unmatch -- "$path" >/dev/null 2>&1; then
    failures+=("untracked: $path")
  fi
done

# .kiro/ itself, every directory under it, every tracked file under it, and every required file.
check_paths=()
if [[ -d .kiro ]]; then
  check_paths+=(".kiro/")
  while IFS= read -r dir; do
    check_paths+=("$dir/")
  done < <(find .kiro -mindepth 1 -type d | sort)
  while IFS= read -r f; do
    check_paths+=("$f")
  done < <(g ls-files -- .kiro)
fi
check_paths+=("${required[@]+"${required[@]}"}")

checked=0
for path in "${check_paths[@]+"${check_paths[@]}"}"; do
  checked=$((checked + 1))
  set +e
  g check-ignore --no-index -q -- "$path"
  status=$?
  set -e
  case "$status" in
    0)
      why="$(g check-ignore --no-index -v -- "$path" 2>/dev/null || true)"
      failures+=("ignored: $path [rule: ${why%%$'\t'*}]")
      ;;
    1) ;;
    *) failures+=("check-ignore error ($status): $path") ;;
  esac
done

echo "commit: $sha"
if (( ${#failures[@]} == 0 )); then
  echo "AG-02 PASS (${#required[@]} required files, $checked paths checked for ignore rules)"
  exit 0
fi
echo "AG-02 FAIL"
printf '  %s\n' "${failures[@]}"
exit 1
