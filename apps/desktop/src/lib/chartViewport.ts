// Pan/zoom math for the dependency chart's viewport. Pure functions over one transform
// shape, so `useChartViewport` stays a thin DOM shell and every piece of the arithmetic is
// unit-tested without a layout engine.

/** A pan/zoom transform: screen = world * k + (x, y). */
export interface ViewTransform {
  x: number;
  y: number;
  k: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Frozen, so a caller holding the shared value can never mutate it for everyone else. */
export const IDENTITY: ViewTransform = Object.freeze({ x: 0, y: 0, k: 1 });

// The zoom range: out far enough to take in a large map whole, in far enough to read a
// node's smallest text.
export const MIN_SCALE = 0.1;
export const MAX_SCALE = 2.5;

// fitBox's defaults: the reference chart's stage padding, and a ceiling just above 1:1 so
// fitting one small node does not blow it up past its natural size.
const FIT_PADDING = 36;
const FIT_MAX_SCALE = 1.1;

/** Clamps a scale into [MIN_SCALE, MAX_SCALE]. NaN, which no clamp can order, becomes 1 so a
 * corrupt input degrades to the natural size rather than an extreme zoom. */
export function clampScale(k: number): number {
  if (Number.isNaN(k)) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, k));
}

/**
 * Zoom by `factor` keeping the world point under screen point `at` fixed, so the content
 * under the cursor (or the stage centre) stays put while everything else grows or shrinks
 * around it. The result's scale is clamped; a factor that is not a positive finite number,
 * or a zoom the clamp swallows entirely, returns `t` itself.
 */
export function zoomAround(
  t: ViewTransform,
  factor: number,
  at: { x: number; y: number }
): ViewTransform {
  if (!(factor > 0) || !Number.isFinite(factor)) return t;
  const k = clampScale(t.k * factor);
  if (k === t.k) return t;
  const ratio = k / t.k;
  return {
    x: at.x - (at.x - t.x) * ratio,
    y: at.y - (at.y - t.y) * ratio,
    k,
  };
}

/** Moves the view by a screen-space delta; the scale is untouched. */
export function panBy(t: ViewTransform, dx: number, dy: number): ViewTransform {
  return { x: t.x + dx, y: t.y + dy, k: t.k };
}

/**
 * The transform that centres world `box` inside `viewport`, leaving `padding` screen px on
 * each side (default 36). The scale is the largest that fits, capped at `maxScale` (default
 * 1.1) and then clamped to [MIN_SCALE, MAX_SCALE]. A viewport without area (unmounted,
 * hidden, or happy-dom, which lays nothing out) has nothing to fit into and yields IDENTITY;
 * a box with no area is treated as 1 world px wide/tall so the fit never divides by zero.
 */
export function fitBox(
  box: Box,
  viewport: Size,
  opts: { padding?: number; maxScale?: number } = {}
): ViewTransform {
  const { width, height } = viewport;
  // Written as a positive test so NaN sizes also land here.
  if (!(width > 0 && height > 0)) return IDENTITY;
  const padding = opts.padding ?? FIT_PADDING;
  const fit = Math.min(
    Math.max(width - padding * 2, 1) / Math.max(box.width, 1),
    Math.max(height - padding * 2, 1) / Math.max(box.height, 1)
  );
  const k = clampScale(Math.min(fit, opts.maxScale ?? FIT_MAX_SCALE));
  return {
    x: width / 2 - (box.x + box.width / 2) * k,
    y: height / 2 - (box.y + box.height / 2) * k,
    k,
  };
}

/**
 * Zoom factor for one wheel event, using d3-zoom's default curve so scrolling feels like the
 * reference chart: pixel deltas (deltaMode 0) are tiny, line deltas (1) medium, page deltas
 * (2) large. `ctrlKey` is how Chromium reports a touchpad pinch, whose deltas are small, so
 * it is boosted tenfold. Scrolling up (negative deltaY) zooms in.
 */
export function wheelFactor(e: {
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
}): number {
  const perUnit = e.deltaMode === 1 ? 0.05 : e.deltaMode !== 0 ? 1 : 0.002;
  return 2 ** (-e.deltaY * perUnit * (e.ctrlKey ? 10 : 1));
}

/**
 * Interpolates `a` toward `b` at `t` in [0, 1] (clamped; the endpoints return `a` and `b`
 * themselves). The scale moves geometrically, so each frame zooms by the same ratio instead
 * of rushing the zoomed-out end, and the world point at the viewport's centre moves in a
 * straight line from where `a` centres to where `b` does; x/y are recomputed from those two
 * for `viewport`. Both scales must be positive, as every transform this module makes is.
 */
export function lerpTransform(
  a: ViewTransform,
  b: ViewTransform,
  t: number,
  viewport: Size
): ViewTransform {
  if (!(t > 0)) return a;
  if (t >= 1) return b;
  const cx = viewport.width / 2;
  const cy = viewport.height / 2;
  const fromX = (cx - a.x) / a.k;
  const fromY = (cy - a.y) / a.k;
  const toX = (cx - b.x) / b.k;
  const toY = (cy - b.y) / b.k;
  const k = a.k * (b.k / a.k) ** t;
  return {
    x: cx - (fromX + (toX - fromX) * t) * k,
    y: cy - (fromY + (toY - fromY) * t) * k,
    k,
  };
}

/** The smallest box covering every box, or null when there are none. */
export function unionBox(boxes: readonly Box[]): Box | null {
  if (boxes.length === 0) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const box of boxes) {
    left = Math.min(left, box.x);
    top = Math.min(top, box.y);
    right = Math.max(right, box.x + box.width);
    bottom = Math.max(bottom, box.y + box.height);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** The CSS `transform` value for an element whose transform-origin is `0 0`. */
export function toCss(t: ViewTransform): string {
  return `translate(${t.x}px, ${t.y}px) scale(${t.k})`;
}
