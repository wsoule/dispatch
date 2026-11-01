#!/usr/bin/env bash
#
# One-off board seeding for the 2026-09-22 review: "more user friendly like
# Lovable, while also team focused".
#
# This project keeps its tasks in the daemon's SQLite database, so they cannot
# be filed from a checkout alone — run this on a machine whose dispatchd owns
# the board. Delete the file once it has run.
#
# It is safe to re-run: every task is matched by title first and skipped if it
# is already on the board.
#
#   scripts/file-friendly-team-tasks.sh --dry-run   # print what it would file
#   scripts/file-friendly-team-tasks.sh
#
# Tasks that already have milestones (preview per run, lens, builder front door) are
# NOT re-filed. Where an existing milestone is the right home for new work, the new
# task is parented to it; if that milestone is gone, a replacement milestone is created.

set -euo pipefail

DISPATCH="${DISPATCH_BIN:-dispatch}"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

# Milestones filed in the 2026-08-22 planning discussion (docs/archive/design/
# lovable-workstreams.md). Referenced, never recreated.
MILESTONE_PREVIEW=e-a27691      # preview per run
MILESTONE_LENS=e-3a6884         # builder/engineer lens
MILESTONE_FRONT_DOOR=e-16ef06   # builder front door
MILESTONE_SHARE=e-dff6d3        # shareable run URLs
MILESTONE_TEAM_LOCAL=e-5f3530   # team-local mode
MILESTONE_SPINE=e-99e113        # storage spine (shipped)

die() { echo "error: $*" >&2; exit 1; }

command -v "$DISPATCH" >/dev/null \
  || die "no '$DISPATCH' on PATH. Set DISPATCH_BIN, or run this from a machine with the app installed."

# Proves both that a project is here and that its daemon is up: on the database
# backend every task command goes through dispatchd, which is the only writer.
BOARD="$("$DISPATCH" task list 2>&1)" \
  || die "could not read the board. On the database backend dispatchd must be running: dispatch serve"

# Column 1 of `task list` is the id (TABLE_HEADER in packages/cli/src/commands/
# task.ts), and formatTable pads rather than truncates, so an exact title match
# recovers the id of a task an earlier run already filed.
id_for_title() { awk -v t="$1" -F'  +' '$5 == t { print $1; exit }' <<<"$BOARD"; }

exists() { "$DISPATCH" task show "$1" >/dev/null 2>&1; }

# create KIND PRIORITY PARENT TITLE DESCRIPTION [BLOCKED_BY...]
# Echoes the new (or existing) task id so callers can parent children to it.
# PARENT and any blocker of "-" is dropped, so a missing milestone degrades to an
# unparented task rather than a dangling reference `task next` would trip on.
create() {
  local kind=$1 priority=$2 parent=$3 title=$4 description=$5
  shift 5

  local existing; existing="$(id_for_title "$title")"
  if [ -n "$existing" ]; then
    echo "  skip   $existing  $title" >&2
    echo "$existing"
    return
  fi

  local args=(task create "$title" --kind "$kind" --priority "$priority" --description "$description")
  [ "$parent" != "-" ] && args+=(--parent "$parent")

  local blockers=()
  local b; for b in "$@"; do [ "$b" != "-" ] && blockers+=("$b"); done
  [ ${#blockers[@]} -gt 0 ] && args+=(--blocked-by "${blockers[@]}")

  if [ "$DRY_RUN" = 1 ]; then
    echo "  would file [$kind/$priority] $title" >&2
    echo "-"
    return
  fi

  local out; out="$("$DISPATCH" "${args[@]}")"
  local id; id="$(awk '{print $2}' <<<"$out")"
  echo "  filed  $id  $title" >&2
  echo "$id"
}

echo "== already filed, not recreated =="
for pair in \
  "$MILESTONE_PREVIEW:preview per run" \
  "$MILESTONE_LENS:builder/engineer lens" \
  "$MILESTONE_FRONT_DOOR:builder front door" \
  "$MILESTONE_SHARE:shareable run URLs" \
  "$MILESTONE_TEAM_LOCAL:team-local mode"; do
  id="${pair%%:*}"; label="${pair#*:}"
  if exists "$id"; then echo "  $id  $label"; else echo "  $id  $label  (GONE — referenced only; any new work that needed it gets a replacement)"; fi
done
echo

# ---------------------------------------------------------------------------
# 1. Information architecture. Genuinely new: the lens milestone is a second shell,
#    this is renaming and demoting inside today's one, and does not wait on it.
# ---------------------------------------------------------------------------
echo "== information architecture =="
IA="$(create milestone high - \
  "Collapse the app's information architecture" \
  "A first run meets nine different nouns for 'your work' (Inbox, Drafts, Brain dump, Plans, Tasks, Control room, Landing, Impact, Sessions) across 15 sidebar rows, 7 settings pages and 167 components, before anything exists to look at. Independent of the lens milestone ($MILESTONE_LENS): renaming and demoting is cheap inside today's shell and does not wait for a second one. Writes: apps/desktop/src/components/shell/Sidebar.tsx, apps/desktop/src/lib/appNav.ts.")"

create task high "$IA" \
  "Group the sidebar into Work, Runs and Inbox" \
  "Nine nouns to three. Work = Tasks + Plans + Brain dump as tabs of one surface; Runs = Sessions + All agents + Landing; Inbox stays as it is. Impact, Git, Control room and Overseer demote behind the command palette, which already carries them (apps/desktop/src/components/shell/CommandPalette.tsx). Writes: apps/desktop/src/components/shell/Sidebar.tsx, apps/desktop/src/lib/appNav.ts." >/dev/null

create task medium "$IA" \
  "Rename the surfaces a newcomer cannot parse" \
  "Control room, Brain dump, Landing, Fleet and Overseer are internal names. Landing in particular means merge queue and reads as an airport. One naming pass across the sidebar, page headers and the command palette, so the label says what the page does." >/dev/null

create task high "$IA" \
  "Open an empty project on a prompt box, not the Control room" \
  "initialNavState opens on 'overview' (apps/desktop/src/lib/appNav.ts:148), so a freshly initialized project shows an empty Control room behind a full sidebar. With no tasks on the board, show AiTaskComposer's textarea and nothing else. Narrower than the builder front door milestone ($MILESTONE_FRONT_DOOR), which is the full planner-graph flow — this is the empty state alone, and it ships without it." >/dev/null

TRY="$(create task medium "$IA" \
  "Retire the Try block from the sidebar" \
  "A nav section whose job is teaching means the surfaces it points at are not discoverable on their own. Fix that in the regrouping, then delete the block. Writes: apps/desktop/src/components/shell/Sidebar.tsx.")"
echo

# ---------------------------------------------------------------------------
# 2. Team. e-5f3530 (team-local mode) was blocked by the storage spine, which
#    has landed — sqliteTaskStore.ts, migrate.ts and receipts.ts are in the
#    tree and `dispatch init --db` is documented. These are its next steps.
# ---------------------------------------------------------------------------
echo "== team-local multiplayer =="
if exists "$MILESTONE_TEAM_LOCAL"; then
  TEAM="$MILESTONE_TEAM_LOCAL"
  echo "  parenting to existing milestone $MILESTONE_TEAM_LOCAL (team-local mode)"
else
  TEAM="$(create milestone high - \
    "Team-local multiplayer on the existing daemon" \
    "Replaces $MILESTONE_TEAM_LOCAL, which is no longer on the board. One shared dispatchd a team can reach, per-user tokens over the existing two-tier auth, the desktop bundle served to browsers, presence and per-user attribution. Unblocked by the storage spine ($MILESTONE_SPINE), which has landed.")"
fi

IDENT="$(create task high "$TEAM" \
  "Give daemon tokens a per-user identity" \
  "dispatchd mints exactly two tokens (packages/server/src/api.ts:4045): agentToken grants the 'request' tier, appToken the 'decide' tier. Those are capability tiers, not people, so nothing on the wire can tell two humans apart — which blocks presence, claims and trustworthy attribution alike. The model already exists on both sides: team.yml carries the roster (packages/core/src/team.ts derives handles from git email and tracks prior addresses) and actorContext.ts already attributes work to human:<handle>. Map token to TeamMember handle and keep the tier as it is. Writes: packages/server/src/api.ts, packages/core/src/team.ts.")"

create task high "$TEAM" \
  "Turn writes-overlap admission into TTL claims" \
  "packages/core/src/conflicts.ts already does the writes-overlap admission check. A claim is that check plus a lease on (taskId, writes[]) and a heartbeat for the life of the run; losing a lease warns the operator and never kills a run (docs/TEAM-SERVER.md section 6). This is a lease around conflict detection that exists, not new conflict detection." "$IDENT" >/dev/null

create task high "$TEAM" \
  "Add a 'whose attention' axis to the decision feed" \
  "packages/server/src/decisionFeed.ts already splits blocking from recorded, and its own comment says the policy engine ($MILESTONE_LENS's sibling, the autonomy ladder) will reclassify items through it. The team move is that same mechanism on one more axis: approvals demote from teammate-blocking to teammate-visible, the way solo gates demoted from blocking to recording. This is what makes 'autonomy with receipts' a team claim rather than a solo one. Writes: packages/server/src/decisionFeed.ts, packages/core/src/policy.ts." "$IDENT" >/dev/null

create task medium "$TEAM" \
  "Derive presence from connected daemons and live runs" \
  "Who is working on what, read off connections and run lifecycle rather than stored separately. Needs per-user identity first, or presence can only report that someone is connected." "$IDENT" >/dev/null

create task medium "$TEAM" \
  "Serve the desktop bundle to teammates' browsers" \
  "Only 6 of the desktop app's source files import @tauri-apps/*, and every IPC call in apps/desktop/src/lib/tauri.ts has a documented isTauri() browser fallback. One shared dispatchd plus that bundle gives a teammate who installs nothing a URL to the board. Registry becomes a server-side project list, native dialogs become a repo picker, editor and Finder actions hide." "$IDENT" >/dev/null
echo

# ---------------------------------------------------------------------------
# 3. The overlap: a run URL is both "everything has a URL" and the team's
#    review packet. Belongs under the share-URL milestone when it still exists.
# ---------------------------------------------------------------------------
echo "== shareable runs =="
SHARE_PARENT=-
if exists "$MILESTONE_SHARE"; then
  SHARE_PARENT="$MILESTONE_SHARE"
  echo "  parenting to existing milestone $MILESTONE_SHARE (shareable run URLs)"
fi
PREVIEW_BLOCKER=-
exists "$MILESTONE_PREVIEW" && PREVIEW_BLOCKER="$MILESTONE_PREVIEW"

create task high "$SHARE_PARENT" \
  "Make the run URL the team's review packet" \
  "Lovable's 'everything has a URL' applied to a team tool is not 'share your app' — it is one URL carrying transcript, diff, findings, rulings and the run's preview. That is exactly the review packet a teammate needs and exactly the receipt an auditor needs, which is the cheapest place the friendly half and the team half of this review meet. Static output, no hosting dependency, and every input is already stored. Blocked on preview per run only for the embedded preview; the rest ships without it." "$PREVIEW_BLOCKER" >/dev/null
echo

cat <<'NOTE'
== recommended order ==
  1. preview per run            (e-a27691, already filed, nothing built yet)
  2. shareable run URLs         (e-dff6d3 + "review packet" task above)
  3. information architecture   (milestone filed above — independent, start any time)
  4. per-user identity          (task filed above — gates every other team task)
  5. team-local multiplayer     (e-5f3530, unblocked now that the spine landed)

== board edit this script cannot make ==
  e-5f3530 (team-local mode) was filed blocked by e-99e113 (storage spine).
  The spine has landed, so that blocker is stale. `dispatch task edit` can add
  blockers but not remove them — clear it in the app.
NOTE
