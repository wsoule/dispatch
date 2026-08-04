const PROJECT_COLOR_COUNT = 8;

/** Maps any stable id onto one of the `--project-color-1..8` tokens in tokens.css. Shared by
 * the project and epic helpers below so the two can never drift into different hash functions
 * and start disagreeing about which color a given id owns. */
function colorForId(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  const index = (hash % PROJECT_COLOR_COUNT) + 1;
  return `var(--project-color-${index})`;
}

/**
 * Deterministically maps a project id to one of the `--project-color-1..8` tokens defined in
 * tokens.css, so every session/card/row belonging to the same project always shows the same
 * color across Sessions, Dashboard, and Timeline — no per-project color needs to be stored.
 */
export function colorForProject(projectId: string): string {
  return colorForId(projectId);
}

/**
 * The same treatment for an epic, giving each swim lane and epic breadcrumb its own stable
 * color. These are categorical (which epic is this) rather than semantic (what does this need
 * from me), so they deliberately draw from the project palette instead of the `--state-*`
 * roles — an epic's color must never be mistaken for a run state.
 */
export function colorForEpic(epicId: string): string {
  return colorForId(epicId);
}
