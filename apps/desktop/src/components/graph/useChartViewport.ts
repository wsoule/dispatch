import { useEffect, useState } from 'react';

import {
  type Box,
  fitBox,
  IDENTITY,
  lerpTransform,
  panBy,
  type Size,
  toCss,
  type ViewTransform,
  wheelFactor,
  zoomAround,
} from '../../lib/chartViewport';

export interface ChartViewportApi {
  /** Callback ref for the viewport element (the stage) that receives wheel/pointer/gesture input. */
  stageRef: (el: HTMLDivElement | null) => void;
  /** Callback ref for the element that gets the CSS transform (transform-origin 0 0). */
  layerRef: (el: HTMLDivElement | null) => void;
  /** Animated zoom by factor around the stage centre. */
  zoomBy: (factor: number) => void;
  /** Fit a world box; animate defaults to true. */
  fit: (
    box: Box,
    opts?: { maxScale?: number; padding?: number; animate?: boolean }
  ) => void;
  /** The stage's current client size (0x0 before mount or in happy-dom). */
  size: () => Size;
  /** The current transform. */
  transform: () => ViewTransform;
  /** Moves the view by a screen offset at once, cancelling any animation. For the chart
   * keeping a node where it was when the layout under it changes, so it is not a user move. */
  pan: (dx: number, dy: number) => void;
  /** True if the pointer gesture that just ended moved past the drag threshold; click
   * handlers call this to ignore the click that ends a pan. Resets on the next pointerdown. */
  wasDrag: () => boolean;
  /** True once the user has panned or zoomed (wheel, drag, pinch, the zoom buttons) since
   * the last `fit`, so automatic refits can leave a view the user chose alone. */
  moved: () => boolean;
  /** Called (at most once a frame) whenever the stage's size changes; null unsubscribes. */
  onResize: (listener: (() => void) | null) => void;
}

const ANIMATION_MS = 320;
/** How far a pressed pointer travels before the press is a pan rather than a click. */
const DRAG_THRESHOLD_PX = 4;
/** Overlay controls inside the stage mark themselves with this so presses on them stay theirs. */
const IGNORE_SELECTOR = '[data-chart-ignore]';
/** The chart's own focusable parts: a focused one is panned into view. */
const REVEAL_SELECTOR = '[data-chart-node], [data-chart-edge]';
/** How far inside the stage edge a focused node is brought. */
const REVEAL_MARGIN_PX = 24;

/** Fast start, gentle landing. */
function easeOutCubic(p: number): number {
  return 1 - (1 - p) ** 3;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** True when an event started inside an overlay control the chart must not take input from. */
function isIgnored(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(IGNORE_SELECTOR) !== null;
}

/** The `scale` of a WebKit GestureEvent, which is not in the DOM typings, or null when the
 * event has none (another engine, or a synthetic event). */
function gestureScaleOf(e: Event): number | null {
  return 'scale' in e && typeof e.scale === 'number' && e.scale > 0
    ? e.scale
    : null;
}

/** A GestureEvent's client position, read the same untyped way; null when it has none. */
function gesturePointOf(e: Event): { x: number; y: number } | null {
  if (!('clientX' in e) || !('clientY' in e)) return null;
  const { clientX, clientY } = e;
  return typeof clientX === 'number' && typeof clientY === 'number'
    ? { x: clientX, y: clientY }
    : null;
}

/** A pressed pointer the stage is watching: still a possible click until it travels past
 * the threshold, then a pan that holds pointer capture on `el`. */
interface Tracking {
  el: HTMLDivElement;
  id: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  panning: boolean;
  /** The stage's inline cursor before the pan set `grabbing`, restored when it ends. */
  cursor: string;
}

interface ChartViewport {
  api: ChartViewportApi;
  /** Re-attaches input listeners to the current stage (mount, or a StrictMode remount). */
  resume: () => void;
  /** Detaches every listener and cancels any animation, keeping the elements and transform. */
  suspend: () => void;
}

/**
 * One viewport's state and input handling as a closure created once per hook instance, so
 * every function it hands out is stable for the component's lifetime. The transform lives
 * here, not in React state, and is written straight to the layer's style: panning and
 * zooming never re-render the chart.
 */
function createChartViewport(): ChartViewport {
  let current: ViewTransform = IDENTITY;
  let stage: HTMLDivElement | null = null;
  let layer: HTMLDivElement | null = null;
  let unlisten: (() => void) | null = null;
  let frame: number | null = null;
  /** Where the running animation is headed, so a second zoomBy builds on it. */
  let destination: ViewTransform | null = null;
  let tracking: Tracking | null = null;
  let dragged = false;
  /** The previous `scale` of an in-progress WebKit pinch; null when none is running. */
  let gestureScale: number | null = null;
  /** The timeout that drops the post-pan click guard; null when no guard is armed. */
  let clickGuard: ReturnType<typeof setTimeout> | null = null;
  /** Whether the user has moved the view since the last fit. */
  let userMoved = false;
  let resizeListener: (() => void) | null = null;

  function paint(el: HTMLDivElement): void {
    el.style.transformOrigin = '0 0';
    el.style.transform = toCss(current);
  }

  /** Makes `next` the current transform and paints it. A transform with a NaN or infinite
   * part (a fit to a box with NaN coordinates, say) is dropped: the browser would ignore it
   * as CSS anyway, and keeping it would poison every later pan and zoom built on it. */
  function apply(next: ViewTransform): void {
    if (
      !(
        Number.isFinite(next.x) &&
        Number.isFinite(next.y) &&
        Number.isFinite(next.k)
      )
    ) {
      return;
    }
    current = next;
    if (layer !== null) paint(layer);
  }

  function size(): Size {
    return stage === null
      ? { width: 0, height: 0 }
      : { width: stage.clientWidth, height: stage.clientHeight };
  }

  function stopAnimation(): void {
    if (frame !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(frame);
    }
    frame = null;
    destination = null;
  }

  /** Eases from the current transform to `next` over ANIMATION_MS, or jumps there when
   * animation is off, unwanted (reduced motion), impossible (no rAF) or invisible (a stage
   * with no area). Starting one cancels any animation already running. */
  function animateTo(next: ViewTransform, animate: boolean): void {
    stopAnimation();
    const viewport = size();
    if (
      !animate ||
      prefersReducedMotion() ||
      typeof requestAnimationFrame !== 'function' ||
      !(viewport.width > 0 && viewport.height > 0)
    ) {
      apply(next);
      return;
    }
    const from = current;
    const start = performance.now();
    const step = () => {
      const p = Math.min(1, (performance.now() - start) / ANIMATION_MS);
      apply(lerpTransform(from, next, easeOutCubic(p), viewport));
      if (p < 1) {
        frame = requestAnimationFrame(step);
      } else {
        frame = null;
        destination = null;
      }
    };
    destination = next;
    frame = requestAnimationFrame(step);
  }

  function dropClickGuard(): void {
    if (clickGuard === null) return;
    clearTimeout(clickGuard);
    clickGuard = null;
    window.removeEventListener('click', swallowClick, true);
  }

  function swallowClick(e: MouseEvent): void {
    e.preventDefault();
    e.stopImmediatePropagation();
    dropClickGuard();
  }

  /**
   * Swallows the click the browser fires right after a pan's pointerup, so a pan that started
   * on a node never also selects it. Engines disagree on where that click lands (Chromium
   * sends it to the capturing stage, WebKit may send it to the node under the pointer), so
   * `wasDrag()` alone only protects handlers that remember to ask. The guard sits on the
   * window's capture phase, ahead of every React handler, and lives for one task, the way
   * d3-drag's does: the click is dispatched in the same task as its pointerup, so the
   * timeout removes the guard before any later, deliberate click.
   */
  function guardNextClick(): void {
    dropClickGuard();
    window.addEventListener('click', swallowClick, true);
    clickGuard = setTimeout(dropClickGuard, 0);
  }

  /** Ends the watched press: releases capture and restores the cursor if it became a pan. */
  function endTracking(): void {
    if (tracking === null) return;
    const { el, id, panning, cursor } = tracking;
    tracking = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
    if (!panning) return;
    el.style.cursor = cursor;
    try {
      if (el.hasPointerCapture(id)) el.releasePointerCapture(id);
    } catch {
      // The pointer is already gone; there is no capture left to release.
    }
  }

  // Move and up are watched on the window, not the stage, so a press that leaves the stage
  // before it becomes a pan (and so before it holds capture) still ends cleanly.
  function onPointerMove(e: PointerEvent): void {
    const t = tracking;
    if (t === null || e.pointerId !== t.id) return;
    // A mouse moving with its primary button up was released somewhere this never heard
    // about (a native context menu swallowed the mouseup, say), so the press is over;
    // without this the chart would pan under a hovering cursor.
    if (e.pointerType === 'mouse' && e.buttons % 2 === 0) {
      endTracking();
      return;
    }
    if (!t.panning) {
      const moved = Math.hypot(e.clientX - t.startX, e.clientY - t.startY);
      if (moved < DRAG_THRESHOLD_PX) return;
      // Capture only now: capturing on pointerdown would send a plain tap's click to the
      // stage instead of the node under the pointer.
      t.panning = true;
      dragged = true;
      try {
        t.el.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic or already-released pointers cannot be captured; the pan still works
        // from the window listeners.
      }
      t.cursor = t.el.style.cursor;
      t.el.style.cursor = 'grabbing';
    }
    // Every pan step, not just the first, wins over an animation (a fit started mid-pan).
    stopAnimation();
    userMoved = true;
    apply(panBy(current, e.clientX - t.lastX, e.clientY - t.lastY));
    t.lastX = e.clientX;
    t.lastY = e.clientY;
  }

  function onPointerUp(e: PointerEvent): void {
    if (tracking === null || e.pointerId !== tracking.id) return;
    // pointercancel is never followed by a click, so only a real release arms the guard.
    if (tracking.panning && e.type === 'pointerup') guardNextClick();
    endTracking();
  }

  /** Attaches every input listener to `el` and returns the function that removes them. */
  function listen(el: HTMLDivElement): () => void {
    /** A client point in the stage's padding box (inside its border), the frame an inset-0
     * layer's transform is relative to. happy-dom has no clientLeft/clientTop, hence `?? 0`. */
    function local(clientX: number, clientY: number): { x: number; y: number } {
      const rect = el.getBoundingClientRect();
      return {
        x: clientX - rect.left - (el.clientLeft ?? 0),
        y: clientY - rect.top - (el.clientTop ?? 0),
      };
    }

    function centre(): { x: number; y: number } {
      return { x: el.clientWidth / 2, y: el.clientHeight / 2 };
    }

    function onWheel(e: WheelEvent): void {
      // A plain scroll over an overlay is left to the overlay (it may scroll); a pinch
      // always zooms the chart, or the webview would zoom the whole page instead.
      if (!e.ctrlKey && isIgnored(e.target)) return;
      e.preventDefault();
      // WebKit reports a pinch through gesture events; never zoom twice for one.
      if (e.ctrlKey && gestureScale !== null) return;
      stopAnimation();
      // happy-dom's WheelEvent is not a MouseEvent and carries no client position.
      const at =
        Number.isFinite(e.clientX) && Number.isFinite(e.clientY)
          ? local(e.clientX, e.clientY)
          : centre();
      userMoved = true;
      apply(zoomAround(current, wheelFactor(e), at));
    }

    // Focus moving to an off-screen node (Tab, Shift+Tab out of the inspector) makes the
    // browser scroll this overflow-hidden stage to reveal it. That offset would sit on top
    // of the transform and throw off the overlays and every fit and zoom anchor, so it is
    // folded into the pan and the scroll put back. The scroll event fires before paint.
    function onScroll(): void {
      const dx = el.scrollLeft;
      const dy = el.scrollTop;
      if (dx === 0 && dy === 0) return;
      el.scrollLeft = 0;
      el.scrollTop = 0;
      stopAnimation();
      apply(panBy(current, -dx, -dy));
    }

    // A node that takes focus while off-stage is panned into view, on every side (the
    // browser can only scroll it in from the right or the bottom, and onScroll above
    // undoes that anyway).
    function onFocusIn(e: FocusEvent): void {
      // A running fit or zoom is already framing what the chart wants shown (a pick it is
      // zooming to); revealing here would cut it short at the stage edge.
      if (frame !== null) return;
      if (!(e.target instanceof Element)) return;
      const part = e.target.closest(REVEAL_SELECTOR);
      if (part === null) return;
      const stageRect = el.getBoundingClientRect();
      const rect = part.getBoundingClientRect();
      const left = stageRect.left + REVEAL_MARGIN_PX;
      const top = stageRect.top + REVEAL_MARGIN_PX;
      const right = stageRect.right - REVEAL_MARGIN_PX;
      const bottom = stageRect.bottom - REVEAL_MARGIN_PX;
      // Wider or taller than the stage: line its start up with the margin.
      const dx =
        rect.left < left || rect.width > right - left
          ? left - rect.left
          : rect.right > right
            ? right - rect.right
            : 0;
      const dy =
        rect.top < top || rect.height > bottom - top
          ? top - rect.top
          : rect.bottom > bottom
            ? bottom - rect.bottom
            : 0;
      if (dx === 0 && dy === 0) return;
      stopAnimation();
      apply(panBy(current, dx, dy));
    }

    function onPointerDown(e: PointerEvent): void {
      // A second finger landing mid-pan neither resets the pan nor starts another.
      if (tracking?.panning === true && tracking.id !== e.pointerId) return;
      endTracking();
      dragged = false;
      if (e.button !== 0 || isIgnored(e.target)) return;
      tracking = {
        el,
        id: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        panning: false,
        cursor: '',
      };
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerUp);
    }

    function onLostCapture(e: PointerEvent): void {
      if (tracking?.panning === true && e.pointerId === tracking.id) {
        endTracking();
      }
    }

    // While a press is watched, text selection and native drag-and-drop (an image, a link)
    // would fight the pan; the browser would also cancel the pointer to run its own drag.
    function onSelectOrDrag(e: Event): void {
      if (tracking !== null) e.preventDefault();
    }

    // A context menu opening (macOS reports ctrl+click as a primary-button press, then
    // opens the menu, which eats the release) ends the press, so it can never turn into a
    // pan once the menu closes.
    function onContextMenu(): void {
      endTracking();
    }

    // WebKit (Tauri's WKWebView on macOS) reports a touchpad pinch as non-standard gesture
    // events whose `scale` is cumulative from gesturestart; each change zooms by the ratio
    // to the previous one. Other engines never fire these, so the listeners stay idle.
    function onGestureStart(e: Event): void {
      e.preventDefault();
      stopAnimation();
      gestureScale = gestureScaleOf(e) ?? 1;
    }

    function onGestureChange(e: Event): void {
      e.preventDefault();
      const scale = gestureScaleOf(e);
      if (scale === null) return;
      const previous = gestureScale ?? 1;
      gestureScale = scale;
      const point = gesturePointOf(e);
      const at = point === null ? centre() : local(point.x, point.y);
      userMoved = true;
      apply(zoomAround(current, scale / previous, at));
    }

    function onGestureEnd(e: Event): void {
      e.preventDefault();
      gestureScale = null;
    }

    // Touch input pans through pointer events only when the browser is told not to
    // scroll or zoom the stage itself.
    const touchAction = el.style.touchAction;
    el.style.touchAction = 'none';
    const active = { passive: false };
    el.addEventListener('wheel', onWheel, active);
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('lostpointercapture', onLostCapture);
    el.addEventListener('selectstart', onSelectOrDrag);
    el.addEventListener('dragstart', onSelectOrDrag);
    el.addEventListener('contextmenu', onContextMenu);
    el.addEventListener('gesturestart', onGestureStart, active);
    el.addEventListener('gesturechange', onGestureChange, active);
    el.addEventListener('gestureend', onGestureEnd, active);
    el.addEventListener('scroll', onScroll);
    el.addEventListener('focusin', onFocusIn);
    // One callback per frame at most, however many size changes a layout pass reports.
    let resizeFrame: number | null = null;
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            if (resizeFrame !== null) return;
            if (typeof requestAnimationFrame !== 'function') {
              resizeListener?.();
              return;
            }
            resizeFrame = requestAnimationFrame(() => {
              resizeFrame = null;
              resizeListener?.();
            });
          });
    observer?.observe(el);
    return () => {
      observer?.disconnect();
      if (resizeFrame !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(resizeFrame);
      }
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('focusin', onFocusIn);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('lostpointercapture', onLostCapture);
      el.removeEventListener('selectstart', onSelectOrDrag);
      el.removeEventListener('dragstart', onSelectOrDrag);
      el.removeEventListener('contextmenu', onContextMenu);
      el.removeEventListener('gesturestart', onGestureStart);
      el.removeEventListener('gesturechange', onGestureChange);
      el.removeEventListener('gestureend', onGestureEnd);
      if (tracking?.el === el) endTracking();
      gestureScale = null;
      el.style.touchAction = touchAction;
    };
  }

  function stageRef(el: HTMLDivElement | null): void {
    if (el === stage && (el === null || unlisten !== null)) return;
    unlisten?.();
    stage = el;
    unlisten = el === null ? null : listen(el);
  }

  function layerRef(el: HTMLDivElement | null): void {
    layer = el;
    if (el !== null) paint(el);
  }

  const api: ChartViewportApi = {
    stageRef,
    layerRef,
    zoomBy: (factor) => {
      const { width, height } = size();
      const base = destination ?? current;
      userMoved = true;
      animateTo(
        zoomAround(base, factor, { x: width / 2, y: height / 2 }),
        true
      );
    },
    fit: (box, opts) => {
      userMoved = false;
      animateTo(fitBox(box, size(), opts), opts?.animate ?? true);
    },
    size,
    transform: () => current,
    pan: (dx, dy) => {
      stopAnimation();
      apply(panBy(current, dx, dy));
    },
    wasDrag: () => dragged,
    moved: () => userMoved,
    onResize: (listener) => {
      resizeListener = listener;
    },
  };

  return {
    api,
    resume: () => {
      if (stage !== null && unlisten === null) unlisten = listen(stage);
    },
    suspend: () => {
      stopAnimation();
      dropClickGuard();
      unlisten?.();
      unlisten = null;
    },
  };
}

/**
 * Pan and zoom for the dependency chart: scroll or pinch to zoom around the pointer, drag
 * empty space or nodes to pan, plus animated `zoomBy`/`fit` for the zoom controls and
 * click-to-trace. Keyboard focus moving onto an off-stage node pans it into view. The
 * returned object and its functions are stable across renders.
 */
export function useChartViewport(): ChartViewportApi {
  const [viewport] = useState(createChartViewport);
  useEffect(() => {
    viewport.resume();
    return viewport.suspend;
  }, [viewport]);
  return viewport.api;
}
