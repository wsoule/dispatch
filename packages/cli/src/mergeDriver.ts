// Re-exports @dispatch/core's merge-driver setup. The implementation lives
// in core (not here) so packages/server/src/bin.ts — which cannot depend on
// @dispatch/cli — can register the same driver from the desktop app's
// project-init path.
export {
  checkMergeDriverSetup,
  checkTeamMergeDriverSetup,
  GITATTRIBUTES_LINE,
  isMergeDriverResolvable,
  mergeGitAttributes,
  registerMergeDriverGitConfig,
  registerTeamMergeDriverGitConfig,
  TEAM_GITATTRIBUTES_LINE,
  writeGitAttributes,
} from '@dispatch/core';
