#!/usr/bin/env sh
unset $(git rev-parse --local-env-vars 2>/dev/null)
cd "$(dirname "$0")/.." 2>/dev/null || exit 0
[ -e .git ] && [ -d .githooks ] || exit 0
top=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
[ "$(cd "$top" 2>/dev/null && pwd -P)" = "$(pwd -P)" ] || exit 0
git config --get core.hooksPath >/dev/null 2>&1 && exit 0
git config --worktree core.hooksPath .githooks >/dev/null 2>&1 ||
	git config --local core.hooksPath .githooks >/dev/null 2>&1
exit 0
