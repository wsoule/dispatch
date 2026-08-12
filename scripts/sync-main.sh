#!/usr/bin/env bash
# Repairs the recurring main/origin split in a checkout dispatchd is live in.
#
# The daemon writes .dispatch/ continuously and the board-syncer pushes to
# origin on its own cadence, so plain `git pull --rebase` here loses races:
# pushes reject seconds after fetching, and a mid-rebase `reset --hard` can
# collide with a daemon write and leave a corrupt .git/rebase-merge behind.
# This script is the sequence that has repaired every variant of that state:
#
#   1. clear a wedged rebase (recovering its autostash),
#   2. land local-only commits on origin via a temp worktree merge — never
#      by rebasing the live checkout,
#   3. move main to origin/main with a --mixed reset plus a selective
#      restore that never touches .dispatch/ (live daemon state) or
#      AGENTS.md (carto keeps regenerating it).
#
# Retired once origin-first merges land (t-f00b6d): the queue will own the
# single writer to origin and the checkout will just fast-forward.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# 1. A wedged rebase blocks everything else; recover its autostash first.
if [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ]; then
  autostash=""
  [ -f .git/rebase-merge/autostash ] && autostash=$(cat .git/rebase-merge/autostash)
  git rebase --abort 2>/dev/null || rm -rf .git/rebase-merge .git/rebase-apply
  if [ -n "$autostash" ]; then
    git stash apply "$autostash" || echo "sync-main: autostash $autostash did not apply cleanly — inspect 'git stash list'"
  fi
  echo "sync-main: cleared wedged rebase state"
fi

git fetch origin

# 2. Local-only commits get merged onto origin's tip in a throwaway worktree
#    and pushed from there — the live checkout's dirty tree never blocks it.
if [ -n "$(git log --oneline origin/main..main)" ]; then
  wt=$(mktemp -d /tmp/dispatch-sync-main.XXXXXX)
  git worktree add "$wt" origin/main --detach >/dev/null
  git -C "$wt" merge "$(git rev-parse main)" --no-edit \
    -m "Merge local main (sync-main)"
  git -C "$wt" push origin HEAD:main
  git worktree remove "$wt"
  git fetch origin
  echo "sync-main: pushed local commits via temp worktree"
fi

# 3. Point main at origin and restore every file the daemon/user is not
#    actively holding. --mixed touches no files itself; the selective
#    checkout below skips .dispatch/ and AGENTS.md.
old=$(git rev-parse main)
git reset --mixed origin/main >/dev/null
# `|| true`: a fully clean (or fully protected) tree leaves grep with no
# matches, which must not read as failure under pipefail.
{ git status --porcelain | grep -E '^ [MD]' | cut -c4- \
  | grep -v '^\.dispatch/' | grep -v '^AGENTS.md$' || true; } \
  | tr '\n' '\0' | xargs -0 -r git checkout --
# Files origin deleted that the old tree still has on disk.
git diff --name-only --diff-filter=D "$old" origin/main | while read -r f; do
  case "$f" in .dispatch/*|AGENTS.md) ;; *) [ -f "$f" ] && rm "$f" ;; esac
done

echo "sync-main: main is at $(git rev-parse --short origin/main), tree preserved for .dispatch/ and AGENTS.md"
