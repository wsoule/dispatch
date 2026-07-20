const PROJECT_COLOR_COUNT = 8;

/**
 * Deterministically maps a project id to one of the `--project-color-1..8` tokens defined in
 * tokens.css, so every session/card/row belonging to the same project always shows the same
 * color across Sessions, Dashboard, and Timeline — no per-project color needs to be stored.
 */
export function colorForProject(projectId: string): string {
  let hash = 0;
  for (let i = 0; i < projectId.length; i++) {
    hash = (hash * 31 + projectId.charCodeAt(i)) >>> 0;
  }
  const index = (hash % PROJECT_COLOR_COUNT) + 1;
  return `var(--project-color-${index})`;
}
