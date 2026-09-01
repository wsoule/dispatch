// Webview zoom (⌘+/⌘−/⌘0), persisted so the chosen size survives a relaunch. The step
// logic is pure and unit-tested; only `applyZoomFactor` touches the platform.

import { isTauri } from './tauri';

const STORAGE_KEY = 'dispatch:zoom';

export const ZOOM_MIN = 0.7;
export const ZOOM_MAX = 1.5;
const ZOOM_STEP = 0.1;

/** The stored zoom factor, defaulting to 1 and clamped in case storage holds garbage. */
export function loadZoomFactor(): number {
  if (typeof window === 'undefined') return 1;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  const parsed = raw === null ? 1 : Number(raw);
  if (Number.isNaN(parsed)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, parsed));
}

/** One ⌘+/⌘−/⌘0 press worth of change, clamped to the supported range. Rounded to one
 * decimal so repeated steps land on clean factors (0.1 increments drift in float math). */
export function stepZoomFactor(
  current: number,
  direction: 'in' | 'out' | 'reset'
): number {
  if (direction === 'reset') return 1;
  const next = direction === 'in' ? current + ZOOM_STEP : current - ZOOM_STEP;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(next * 10) / 10));
}

/** Applies and persists a zoom factor. In the packaged app this is the webview's own page
 * zoom (crisp, no layout quirks); the browser dev harness falls back to CSS zoom on the
 * root element, which is close enough for development. */
export function applyZoomFactor(factor: number): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, String(factor));
  if (isTauri()) {
    void import('@tauri-apps/api/webview').then(({ getCurrentWebview }) =>
      getCurrentWebview().setZoom(factor)
    );
  } else {
    (
      document.documentElement.style as CSSStyleDeclaration & { zoom: string }
    ).zoom = factor === 1 ? '' : String(factor);
  }
}
