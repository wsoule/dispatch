/**
 * Whether the review's side panels are open, remembered across sessions.
 *
 * A reading preference belonging to one person at one desk, so localStorage
 * rather than the run — the same reasoning as `reviewViewed`.
 */
export type ReviewPanel = 'files' | 'threads' | 'review';

// Files open because a multi-file review needs navigation; threads closed
// because most reviews start with nothing in them. `review` is the PR rail,
// and it opens because approving a PR is only possible from inside it.
const DEFAULTS: Record<ReviewPanel, boolean> = {
  files: true,
  threads: false,
  review: true,
};

function key(panel: ReviewPanel): string {
  return `dispatch:review-panel:${panel}`;
}

export function readPanelOpen(panel: ReviewPanel): boolean {
  if (typeof window === 'undefined') return DEFAULTS[panel];
  try {
    const raw = window.localStorage.getItem(key(panel));
    if (raw === '1') return true;
    if (raw === '0') return false;
    return DEFAULTS[panel];
  } catch {
    return DEFAULTS[panel];
  }
}

export function writePanelOpen(panel: ReviewPanel, open: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key(panel), open ? '1' : '0');
  } catch {
    // Storage full or blocked. Losing the preference is survivable; failing
    // the click is not.
  }
}
