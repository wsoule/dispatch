import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, spyOn } from 'bun:test';
import { StrictMode } from 'react';

import { fitBox, IDENTITY, toCss } from '../../lib/chartViewport';
import { type ChartViewportApi, useChartViewport } from './useChartViewport';

interface ChartProps {
  apis: ChartViewportApi[];
  onNodeClick?: () => void;
  /** Changing a key swaps in a fresh stage or layer element, as a remount would. */
  stageKey?: string;
  layerKey?: string;
}

/** A stage with one node inside the transformed layer and one overlay control outside it;
 * every render's api lands in `apis` so tests can drive it and check its stability. */
function Chart({ apis, onNodeClick, stageKey, layerKey }: ChartProps) {
  const api = useChartViewport();
  apis.push(api);
  return (
    <div key={stageKey} data-testid="stage" ref={api.stageRef}>
      <div key={layerKey} data-testid="layer" ref={api.layerRef}>
        <div data-chart-node="n1" data-testid="node">
          <button type="button" onClick={onNodeClick}>
            Node
          </button>
        </div>
      </div>
      <div data-chart-ignore>
        <button type="button">Zoom in</button>
      </div>
    </div>
  );
}

function mount() {
  const apis: ChartViewportApi[] = [];
  const view = render(<Chart apis={apis} />);
  const stage = screen.getByTestId('stage');
  const layer = screen.getByTestId('layer');
  return { apis, api: apis[0], view, stage, layer };
}

/** Takes over requestAnimationFrame, cancelAnimationFrame and the clock so a test steps an
 * animation by hand (happy-dom's own rAF spins on setImmediate). `restore` must run in a
 * finally. */
function manualFrames() {
  const frames = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  let now = 1000;
  const raf = spyOn(globalThis, 'requestAnimationFrame').mockImplementation(
    (callback) => {
      frames.set(nextId, callback);
      return nextId++;
    }
  );
  const caf = spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(
    (id) => {
      frames.delete(id);
    }
  );
  const clock = spyOn(performance, 'now').mockImplementation(() => now);
  return {
    frames,
    /** Runs every callback queued before this frame, as a browser frame would. */
    runFrame(at: number) {
      now = at;
      const due = [...frames];
      frames.clear();
      for (const [, callback] of due) callback(at);
    },
    restore() {
      raf.mockRestore();
      caf.mockRestore();
      clock.mockRestore();
    },
  };
}

/** One press on `target` that travels `distance` px right, then lets go. */
function press(target: Element, distance: number) {
  fireEvent.pointerDown(target, { button: 0, pointerId: 1 });
  fireEvent.pointerMove(target, { pointerId: 1, clientX: distance });
  fireEvent.pointerUp(target, { pointerId: 1, clientX: distance });
}

/** Lets the one-task post-pan click guard expire. */
function nextTask() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** happy-dom lays nothing out, so give the stage the size and position a real one would have. */
function placeStage(stage: HTMLElement, left: number, top: number) {
  stage.getBoundingClientRect = () => new DOMRect(left, top, 800, 600);
  Object.defineProperty(stage, 'clientWidth', {
    value: 800,
    configurable: true,
  });
  Object.defineProperty(stage, 'clientHeight', {
    value: 600,
    configurable: true,
  });
}

describe('useChartViewport', () => {
  it('keeps one api across renders and paints the layer on mount', () => {
    const { apis, view, layer } = mount();
    view.rerender(<Chart apis={apis} />);
    expect(apis.length).toBeGreaterThan(1);
    for (const api of apis) expect(api).toBe(apis[0]);
    expect(layer.style.transform).toBe(toCss(IDENTITY));
    expect(layer.style.transformOrigin).toBe('0 0');
  });

  it('zooms around the pointer on wheel and swallows the scroll', () => {
    const { api, stage, layer } = mount();
    placeStage(stage, 100, 50);
    // happy-dom's WheelEvent drops clientX/clientY, so set them the way a browser would.
    const wheel = new WheelEvent('wheel', {
      deltaY: -100,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperties(wheel, {
      clientX: { value: 150 },
      clientY: { value: 80 },
    });
    const notPrevented = fireEvent(stage, wheel);
    expect(notPrevented).toBe(false);
    const t = api.transform();
    expect(t.k).toBeCloseTo(2 ** 0.2);
    // The world point under the pointer (stage-local 50, 30) stays under it.
    expect(50 * t.k + t.x).toBeCloseTo(50);
    expect(30 * t.k + t.y).toBeCloseTo(30);
    expect(layer.style.transform).toBe(toCss(t));
  });

  it('zooms around the stage centre when a wheel event has no position', () => {
    const { api, stage } = mount();
    placeStage(stage, 0, 0);
    fireEvent.wheel(stage, { deltaY: 100 });
    const t = api.transform();
    expect(t.k).toBeCloseTo(2 ** -0.2);
    expect(400 * t.k + t.x).toBeCloseTo(400);
    expect(300 * t.k + t.y).toBeCloseTo(300);
  });

  it('leaves a plain scroll over an overlay control to the overlay', () => {
    const { api } = mount();
    const notPrevented = fireEvent.wheel(screen.getByText('Zoom in'), {
      deltaY: 100,
    });
    expect(notPrevented).toBe(true);
    expect(api.transform()).toEqual(IDENTITY);
  });

  it('treats a press that barely moves as a click, not a drag', () => {
    const { api, stage } = mount();
    const node = screen.getByText('Node');
    fireEvent.pointerDown(node, { button: 0, pointerId: 1, clientX: 10 });
    fireEvent.pointerMove(node, { pointerId: 1, clientX: 12, clientY: 1 });
    fireEvent.pointerUp(node, { pointerId: 1, clientX: 12, clientY: 1 });
    expect(api.wasDrag()).toBe(false);
    expect(api.transform()).toEqual(IDENTITY);
    expect(stage.style.cursor).toBe('');
  });

  it('pans once the pointer passes the threshold and flags the drag', () => {
    const { api, stage, layer } = mount();
    const node = screen.getByText('Node');
    fireEvent.pointerDown(node, { button: 0, pointerId: 1 });
    fireEvent.pointerMove(node, { pointerId: 1, clientX: 30, clientY: 10 });
    expect(stage.style.cursor).toBe('grabbing');
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 40, clientY: 25 });
    expect(api.transform()).toEqual({ x: 40, y: 25, k: 1 });
    expect(layer.style.transform).toBe(toCss({ x: 40, y: 25, k: 1 }));
    fireEvent.pointerUp(stage, { pointerId: 1 });
    expect(api.wasDrag()).toBe(true);
    expect(stage.style.cursor).toBe('');
    fireEvent.pointerDown(node, { button: 0, pointerId: 1 });
    expect(api.wasDrag()).toBe(false);
  });

  it('leaves presses on overlay controls alone', () => {
    const { api } = mount();
    const control = screen.getByText('Zoom in');
    fireEvent.pointerDown(control, { button: 0, pointerId: 1 });
    fireEvent.pointerMove(control, { pointerId: 1, clientX: 80, clientY: 80 });
    fireEvent.pointerUp(control, { pointerId: 1 });
    expect(api.transform()).toEqual(IDENTITY);
    expect(api.wasDrag()).toBe(false);
  });

  it('fits without throwing on a stage not laid out, and centres once sized', () => {
    const { api, stage } = mount();
    const box = { x: 0, y: 0, width: 400, height: 200 };
    expect(() => api.fit(box)).not.toThrow();
    expect(api.transform()).toEqual(IDENTITY);
    placeStage(stage, 0, 0);
    api.fit(box, { animate: false });
    expect(api.transform()).toEqual(fitBox(box, { width: 800, height: 600 }));
  });

  it('refuses a non-finite transform instead of getting stuck on it', () => {
    const { api, stage, layer } = mount();
    placeStage(stage, 0, 0);
    api.fit(
      { x: Number.NaN, y: 0, width: 400, height: 200 },
      { animate: false }
    );
    expect(api.transform()).toEqual(IDENTITY);
    expect(layer.style.transform).toBe(toCss(IDENTITY));
    fireEvent.wheel(stage, { deltaY: -100 });
    expect(Number.isFinite(api.transform().x)).toBe(true);
  });

  it('animates a fit to its target over a few frames', () => {
    const anim = manualFrames();
    try {
      const { api, stage } = mount();
      placeStage(stage, 0, 0);
      const box = { x: 0, y: 0, width: 400, height: 200 };
      const target = fitBox(box, { width: 800, height: 600 });
      api.fit(box);
      expect(api.transform()).toEqual(IDENTITY);
      anim.runFrame(1160);
      const mid = api.transform();
      expect(mid.k).toBeGreaterThan(1);
      expect(mid.k).toBeLessThan(target.k);
      anim.runFrame(1400);
      expect(api.transform()).toEqual(target);
      expect(anim.frames.size).toBe(0);
    } finally {
      anim.restore();
    }
  });

  it('chains quick zoomBy calls onto the running target', () => {
    const anim = manualFrames();
    try {
      const { api, stage } = mount();
      placeStage(stage, 0, 0);
      api.zoomBy(1.5);
      anim.runFrame(1100);
      api.zoomBy(1.5);
      while (anim.frames.size > 0) anim.runFrame(2000);
      const t = api.transform();
      expect(t.k).toBeCloseTo(2.25);
      // Both zooms were around the stage centre, so it is still the same world point.
      expect(400 * t.k + t.x).toBeCloseTo(400);
      expect(300 * t.k + t.y).toBeCloseTo(300);
    } finally {
      anim.restore();
    }
  });

  it('lets wheel and pan input cancel a running animation', () => {
    const anim = manualFrames();
    try {
      const { api, stage } = mount();
      placeStage(stage, 0, 0);
      const box = { x: 0, y: 0, width: 400, height: 200 };
      api.fit(box);
      fireEvent.wheel(stage, { deltaY: 100 });
      const afterWheel = api.transform();
      anim.runFrame(1400);
      expect(api.transform()).toBe(afterWheel);

      // A fit that starts mid-pan is overridden by the very next pan step.
      fireEvent.pointerDown(stage, { button: 0, pointerId: 1 });
      fireEvent.pointerMove(stage, { pointerId: 1, clientX: 10 });
      api.fit(box);
      fireEvent.pointerMove(stage, { pointerId: 1, clientX: 20 });
      const afterPan = api.transform();
      while (anim.frames.size > 0) anim.runFrame(3000);
      expect(api.transform()).toBe(afterPan);
      expect(afterPan.k).toBe(afterWheel.k);
    } finally {
      anim.restore();
    }
  });

  it('jumps instead of animating when reduced motion is preferred', () => {
    const media = spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches: query === '(prefers-reduced-motion: reduce)',
          media: query,
        }) as MediaQueryList
    );
    try {
      const { api, stage } = mount();
      placeStage(stage, 0, 0);
      api.zoomBy(2);
      expect(api.transform()).toEqual({ x: -400, y: -300, k: 2 });
    } finally {
      media.mockRestore();
    }
  });

  it('stops animating and listening once unmounted', async () => {
    const { api, stage, view } = mount();
    placeStage(stage, 0, 0);
    fireEvent.pointerDown(stage, { button: 0, pointerId: 1 });
    api.fit({ x: 0, y: 0, width: 400, height: 200 });
    view.unmount();
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 50, clientY: 50 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(api.transform()).toEqual(IDENTITY);
  });

  it('zooms on WebKit pinch gestures by the change in scale', () => {
    const { api, stage } = mount();
    placeStage(stage, 0, 0);
    const gesture = (type: string, scale: number) =>
      fireEvent(
        stage,
        Object.assign(new Event(type, { cancelable: true }), {
          scale,
          clientX: 200,
          clientY: 100,
        })
      );
    expect(gesture('gesturestart', 1)).toBe(false);
    gesture('gesturechange', 1.5);
    gesture('gesturechange', 2);
    gesture('gestureend', 2);
    const t = api.transform();
    expect(t.k).toBeCloseTo(2);
    expect(200 * t.k + t.x).toBeCloseTo(200);
    expect(100 * t.k + t.y).toBeCloseTo(100);
  });

  it('captures the pointer only once a press becomes a pan, and releases it after', () => {
    const { stage } = mount();
    const node = screen.getByText('Node');
    fireEvent.pointerDown(node, { button: 0, pointerId: 7 });
    fireEvent.pointerMove(node, { pointerId: 7, clientX: 3 });
    expect(stage.hasPointerCapture(7)).toBe(false);
    fireEvent.pointerMove(node, { pointerId: 7, clientX: 4 });
    expect(stage.hasPointerCapture(7)).toBe(true);
    fireEvent.pointerUp(stage, { pointerId: 7 });
    expect(stage.hasPointerCapture(7)).toBe(false);
  });

  it('swallows only the click that ends a pan', async () => {
    let clicks = 0;
    const apis: ChartViewportApi[] = [];
    render(<Chart apis={apis} onNodeClick={() => clicks++} />);
    const node = screen.getByText('Node');
    press(node, 20);
    fireEvent.click(node);
    expect(clicks).toBe(0);
    expect(apis[0].wasDrag()).toBe(true);
    await nextTask();
    // The guard is gone a task later, and a plain tap's click always gets through.
    press(node, 1);
    fireEvent.click(node);
    expect(clicks).toBe(1);
    expect(apis[0].wasDrag()).toBe(false);
  });

  it('ends a press whose mouse release it never saw', () => {
    const { api, stage } = mount();
    const mouse = { pointerId: 1, pointerType: 'mouse' };
    fireEvent.pointerDown(stage, { ...mouse, button: 0, buttons: 1 });
    // The button came up somewhere else; a hover must not pan.
    fireEvent.pointerMove(stage, { ...mouse, buttons: 0, clientX: 40 });
    fireEvent.pointerMove(stage, { ...mouse, buttons: 1, clientX: 80 });
    expect(api.transform()).toEqual(IDENTITY);
    expect(api.wasDrag()).toBe(false);

    // macOS ctrl+click: a primary press, then a context menu that eats the release.
    fireEvent.pointerDown(stage, { ...mouse, button: 0, buttons: 1 });
    fireEvent.contextMenu(stage);
    fireEvent.pointerMove(stage, { ...mouse, buttons: 1, clientX: 40 });
    expect(api.transform()).toEqual(IDENTITY);
  });

  it('ends a pan on pointercancel or lost capture', () => {
    const { api, stage } = mount();
    stage.style.cursor = 'grab';
    for (const end of ['pointerCancel', 'lostPointerCapture'] as const) {
      fireEvent.pointerDown(stage, { button: 0, pointerId: 1 });
      fireEvent.pointerMove(stage, { pointerId: 1, clientX: 10 });
      expect(stage.style.cursor).toBe('grabbing');
      fireEvent[end](stage, { pointerId: 1 });
      expect(stage.style.cursor).toBe('grab');
      expect(stage.hasPointerCapture(1)).toBe(false);
      const after = api.transform();
      fireEvent.pointerMove(stage, { pointerId: 1, clientX: 90 });
      expect(api.transform()).toBe(after);
    }
  });

  it('never pans from a secondary button, yet resets wasDrag on it', () => {
    const { api, stage } = mount();
    press(stage, 20);
    expect(api.wasDrag()).toBe(true);
    fireEvent.pointerDown(stage, { button: 2, pointerId: 1 });
    expect(api.wasDrag()).toBe(false);
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 60 });
    expect(api.transform()).toEqual({ x: 20, y: 0, k: 1 });
  });

  it('keeps listening through StrictMode remounts and stops after unmount', () => {
    const apis: ChartViewportApi[] = [];
    const view = render(
      <StrictMode>
        <Chart apis={apis} />
      </StrictMode>
    );
    const stage = screen.getByTestId('stage');
    const layer = screen.getByTestId('layer');
    const api = apis[apis.length - 1];
    view.rerender(
      <StrictMode>
        <Chart apis={apis} />
      </StrictMode>
    );
    expect(apis[apis.length - 1]).toBe(api);
    expect(stage.style.touchAction).toBe('none');
    fireEvent.wheel(stage, { deltaY: -100 });
    expect(api.transform().k).toBeCloseTo(2 ** 0.2);
    expect(layer.style.transform).toBe(toCss(api.transform()));
    view.unmount();
    const before = api.transform();
    fireEvent.wheel(stage, { deltaY: -100 });
    expect(api.transform()).toBe(before);
    expect(stage.style.touchAction).toBe('');
  });

  it('moves its listeners to a new stage and paints a new layer at once', () => {
    const apis: ChartViewportApi[] = [];
    const view = render(<Chart apis={apis} stageKey="a" layerKey="a" />);
    const oldStage = screen.getByTestId('stage');
    const api = apis[0];
    fireEvent.wheel(oldStage, { deltaY: -100 });
    const zoomed = api.transform();

    view.rerender(<Chart apis={apis} stageKey="b" layerKey="b" />);
    const newStage = screen.getByTestId('stage');
    expect(newStage).not.toBe(oldStage);
    expect(screen.getByTestId('layer').style.transform).toBe(toCss(zoomed));
    expect(oldStage.style.touchAction).toBe('');

    fireEvent.wheel(oldStage, { deltaY: -100 });
    expect(api.transform()).toBe(zoomed);
    fireEvent.wheel(newStage, { deltaY: -100 });
    expect(api.transform().k).toBeGreaterThan(zoomed.k);
  });

  it('turns a scroll of the stage (focus revealing a node) into a pan', () => {
    const { api, stage } = mount();
    stage.scrollLeft = 120;
    stage.scrollTop = 40;
    fireEvent.scroll(stage);
    expect(stage.scrollLeft).toBe(0);
    expect(stage.scrollTop).toBe(0);
    expect(api.transform()).toEqual({ x: -120, y: -40, k: 1 });
  });

  it('pans a node that takes focus off-stage into view, on any side', () => {
    const { api, stage } = mount();
    placeStage(stage, 0, 0);
    const node = screen.getByTestId('node');
    // Off the left edge, then off the bottom edge.
    node.getBoundingClientRect = () => new DOMRect(-300, 100, 200, 60);
    fireEvent.focusIn(screen.getByText('Node'));
    expect(api.transform()).toEqual({ x: 324, y: 0, k: 1 });
    node.getBoundingClientRect = () => new DOMRect(100, 590, 200, 60);
    fireEvent.focusIn(screen.getByText('Node'));
    expect(api.transform()).toEqual({ x: 324, y: -74, k: 1 });
    // Already in view: nothing moves.
    node.getBoundingClientRect = () => new DOMRect(100, 100, 200, 60);
    fireEvent.focusIn(screen.getByText('Node'));
    expect(api.transform()).toEqual({ x: 324, y: -74, k: 1 });
  });

  it('remembers that the user moved the view until the next fit', () => {
    const { api, stage } = mount();
    placeStage(stage, 0, 0);
    expect(api.moved()).toBe(false);
    fireEvent.wheel(stage, { deltaY: -100 });
    expect(api.moved()).toBe(true);
    api.fit({ x: 0, y: 0, width: 400, height: 200 }, { animate: false });
    expect(api.moved()).toBe(false);
    press(stage, 20);
    expect(api.moved()).toBe(true);
    api.fit({ x: 0, y: 0, width: 400, height: 200 }, { animate: false });
    api.zoomBy(2);
    expect(api.moved()).toBe(true);
  });
});
