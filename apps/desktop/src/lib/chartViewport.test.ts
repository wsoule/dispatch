import { describe, expect, it } from 'bun:test';

import {
  clampScale,
  fitBox,
  IDENTITY,
  lerpTransform,
  MAX_SCALE,
  MIN_SCALE,
  panBy,
  toCss,
  unionBox,
  type ViewTransform,
  wheelFactor,
  zoomAround,
} from './chartViewport';

/** Where a screen point lands in world space under `t`, the inverse of the transform. */
function worldAt(t: ViewTransform, x: number, y: number) {
  return { x: (x - t.x) / t.k, y: (y - t.y) / t.k };
}

/** Where a world point lands on screen under `t`. */
function screenOf(t: ViewTransform, x: number, y: number) {
  return { x: x * t.k + t.x, y: y * t.k + t.y };
}

describe('constants', () => {
  it('IDENTITY is the neutral view and cannot be mutated', () => {
    expect(IDENTITY).toEqual({ x: 0, y: 0, k: 1 });
    expect(Object.isFrozen(IDENTITY)).toBe(true);
  });

  it('exposes the zoom range', () => {
    expect(MIN_SCALE).toBe(0.1);
    expect(MAX_SCALE).toBe(2.5);
  });
});

describe('clampScale', () => {
  it('passes scales inside the range through', () => {
    expect(clampScale(1)).toBe(1);
    expect(clampScale(MIN_SCALE)).toBe(MIN_SCALE);
    expect(clampScale(MAX_SCALE)).toBe(MAX_SCALE);
  });

  it('clamps scales outside the range', () => {
    expect(clampScale(0.01)).toBe(MIN_SCALE);
    expect(clampScale(0)).toBe(MIN_SCALE);
    expect(clampScale(-3)).toBe(MIN_SCALE);
    expect(clampScale(10)).toBe(MAX_SCALE);
    expect(clampScale(Infinity)).toBe(MAX_SCALE);
  });

  it('turns NaN into the natural scale', () => {
    expect(clampScale(Number.NaN)).toBe(1);
  });
});

describe('zoomAround', () => {
  const start: ViewTransform = { x: 40, y: -20, k: 0.8 };

  it('keeps the world point under the anchor fixed', () => {
    const at = { x: 300, y: 125 };
    const before = worldAt(start, at.x, at.y);
    const next = zoomAround(start, 1.5, at);
    expect(next.k).toBeCloseTo(1.2);
    const after = worldAt(next, at.x, at.y);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it('keeps the anchor fixed when the scale is clamped', () => {
    const at = { x: 10, y: 400 };
    const before = worldAt(start, at.x, at.y);
    const next = zoomAround(start, 100, at);
    expect(next.k).toBe(MAX_SCALE);
    const after = worldAt(next, at.x, at.y);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);

    expect(zoomAround(start, 0.0001, at).k).toBe(MIN_SCALE);
  });

  it('returns the same transform when the clamp swallows the zoom', () => {
    const atMax: ViewTransform = { x: 5, y: 5, k: MAX_SCALE };
    expect(zoomAround(atMax, 2, { x: 50, y: 50 })).toBe(atMax);
    const atMin: ViewTransform = { x: 5, y: 5, k: MIN_SCALE };
    expect(zoomAround(atMin, 0.5, { x: 50, y: 50 })).toBe(atMin);
    expect(zoomAround(start, 1, { x: 50, y: 50 })).toBe(start);
  });

  it('round-trips: zooming in then out by the same factor restores the view', () => {
    const at = { x: 123, y: 456 };
    const back = zoomAround(zoomAround(start, 1.7, at), 1 / 1.7, at);
    expect(back.x).toBeCloseTo(start.x);
    expect(back.y).toBeCloseTo(start.y);
    expect(back.k).toBeCloseTo(start.k);
  });

  it('ignores factors that are not positive finite numbers', () => {
    for (const factor of [0, -2, Number.NaN, Infinity]) {
      expect(zoomAround(start, factor, { x: 0, y: 0 })).toBe(start);
    }
  });

  it('does not mutate its input', () => {
    const t = { x: 1, y: 2, k: 1 };
    zoomAround(t, 2, { x: 10, y: 10 });
    expect(t).toEqual({ x: 1, y: 2, k: 1 });
  });
});

describe('panBy', () => {
  it('moves by the screen delta and keeps the scale', () => {
    const t = { x: 10, y: 20, k: 1.7 };
    expect(panBy(t, 5, -30)).toEqual({ x: 15, y: -10, k: 1.7 });
    expect(t).toEqual({ x: 10, y: 20, k: 1.7 });
  });
});

describe('fitBox', () => {
  it('centres the box in the viewport', () => {
    const box = { x: 100, y: 50, width: 400, height: 200 };
    const viewport = { width: 800, height: 600 };
    const t = fitBox(box, viewport);
    const centre = screenOf(t, box.x + box.width / 2, box.y + box.height / 2);
    expect(centre.x).toBeCloseTo(400);
    expect(centre.y).toBeCloseTo(300);
  });

  it('scales a large box down to fit inside the padding', () => {
    const box = { x: 0, y: 0, width: 1000, height: 500 };
    const t = fitBox(box, { width: 536, height: 336 });
    // (536 - 72) / 1000 = 0.464 beats (336 - 72) / 500 = 0.528.
    expect(t.k).toBeCloseTo(0.464);
    const topLeft = screenOf(t, 0, 0);
    expect(topLeft.x).toBeCloseTo(36);
  });

  it('caps a small box at the default max scale of 1.1', () => {
    const t = fitBox(
      { x: 0, y: 0, width: 50, height: 20 },
      { width: 800, height: 600 }
    );
    expect(t.k).toBeCloseTo(1.1);
  });

  it('honours custom padding and max scale', () => {
    const box = { x: 0, y: 0, width: 100, height: 100 };
    expect(
      fitBox(box, { width: 300, height: 300 }, { padding: 0, maxScale: 5 }).k
    ).toBe(MAX_SCALE);
    expect(
      fitBox(box, { width: 300, height: 300 }, { padding: 50, maxScale: 5 }).k
    ).toBeCloseTo(2);
    expect(fitBox(box, { width: 300, height: 300 }, { maxScale: 0.5 }).k).toBe(
      0.5
    );
  });

  it('fills the padded viewport exactly on the tighter axis, centring the other', () => {
    const box = { x: -50, y: 20, width: 200, height: 100 };
    const t = fitBox(
      box,
      { width: 500, height: 500 },
      { padding: 50, maxScale: 5 }
    );
    // (500 - 100) / 200 = 2 on x beats 4 on y.
    expect(t.k).toBeCloseTo(2);
    const topLeft = screenOf(t, box.x, box.y);
    const bottomRight = screenOf(t, box.x + box.width, box.y + box.height);
    expect(topLeft.x).toBeCloseTo(50);
    expect(bottomRight.x).toBeCloseTo(450);
    expect(topLeft.y).toBeCloseTo(150);
    expect(bottomRight.y).toBeCloseTo(350);
  });

  it('clamps a maxScale below the zoom range up to MIN_SCALE', () => {
    const box = { x: 0, y: 0, width: 100, height: 100 };
    expect(fitBox(box, { width: 800, height: 600 }, { maxScale: 0.01 }).k).toBe(
      MIN_SCALE
    );
  });

  it('clamps a huge box to the minimum scale', () => {
    const t = fitBox(
      { x: 0, y: 0, width: 1e6, height: 1e6 },
      { width: 800, height: 600 }
    );
    expect(t.k).toBe(MIN_SCALE);
  });

  it('returns IDENTITY for a viewport without area', () => {
    const box = { x: 10, y: 10, width: 100, height: 100 };
    expect(fitBox(box, { width: 0, height: 0 })).toBe(IDENTITY);
    expect(fitBox(box, { width: 800, height: 0 })).toBe(IDENTITY);
    expect(fitBox(box, { width: -5, height: 600 })).toBe(IDENTITY);
    expect(fitBox(box, { width: Number.NaN, height: 600 })).toBe(IDENTITY);
  });

  it('fits a zero-size box without dividing by zero', () => {
    const t = fitBox(
      { x: 200, y: 100, width: 0, height: 0 },
      { width: 800, height: 600 }
    );
    expect(Number.isFinite(t.x)).toBe(true);
    expect(Number.isFinite(t.y)).toBe(true);
    expect(t.k).toBeCloseTo(1.1);
    const point = screenOf(t, 200, 100);
    expect(point.x).toBeCloseTo(400);
    expect(point.y).toBeCloseTo(300);
  });

  it('still produces a finite fit when the padding exceeds the viewport', () => {
    const t = fitBox(
      { x: 0, y: 0, width: 100, height: 100 },
      { width: 40, height: 40 }
    );
    expect(t.k).toBe(MIN_SCALE);
    expect(Number.isFinite(t.x)).toBe(true);
  });
});

describe('wheelFactor', () => {
  it('follows d3-zoom per delta mode', () => {
    expect(
      wheelFactor({ deltaY: 100, deltaMode: 0, ctrlKey: false })
    ).toBeCloseTo(2 ** -0.2);
    expect(
      wheelFactor({ deltaY: 3, deltaMode: 1, ctrlKey: false })
    ).toBeCloseTo(2 ** -0.15);
    expect(wheelFactor({ deltaY: 1, deltaMode: 2, ctrlKey: false })).toBe(0.5);
  });

  it('zooms in when scrolling up and does nothing with no delta', () => {
    expect(
      wheelFactor({ deltaY: -100, deltaMode: 0, ctrlKey: false })
    ).toBeGreaterThan(1);
    expect(wheelFactor({ deltaY: 0, deltaMode: 0, ctrlKey: false })).toBe(1);
  });

  it('boosts a pinch (ctrlKey) tenfold', () => {
    expect(
      wheelFactor({ deltaY: 10, deltaMode: 0, ctrlKey: true })
    ).toBeCloseTo(2 ** -0.2);
  });

  it('matches the d3-zoom formula across modes, signs and modifiers', () => {
    for (const deltaMode of [0, 1, 2]) {
      for (const deltaY of [-120, -3, 0.5, 53]) {
        for (const ctrlKey of [false, true]) {
          const perUnit = deltaMode === 1 ? 0.05 : deltaMode === 2 ? 1 : 0.002;
          expect(wheelFactor({ deltaY, deltaMode, ctrlKey })).toBeCloseTo(
            2 ** (-deltaY * perUnit * (ctrlKey ? 10 : 1)),
            10
          );
        }
      }
    }
  });
});

describe('lerpTransform', () => {
  const viewport = { width: 800, height: 600 };
  const a: ViewTransform = { x: 0, y: 0, k: 0.5 };
  const b: ViewTransform = { x: -300, y: 120, k: 2 };

  it('returns the endpoints exactly at t=0 and t=1', () => {
    expect(lerpTransform(a, b, 0, viewport)).toBe(a);
    expect(lerpTransform(a, b, 1, viewport)).toBe(b);
  });

  it('clamps t outside [0, 1]', () => {
    expect(lerpTransform(a, b, -0.5, viewport)).toBe(a);
    expect(lerpTransform(a, b, 3, viewport)).toBe(b);
    expect(lerpTransform(a, b, Number.NaN, viewport)).toBe(a);
  });

  it('interpolates the scale geometrically', () => {
    expect(lerpTransform(a, b, 0.5, viewport).k).toBeCloseTo(1);
    expect(lerpTransform(a, b, 0.25, viewport).k).toBeCloseTo(0.5 * 2 ** 0.5);
  });

  it('moves the world point at the viewport centre in a straight line', () => {
    const from = worldAt(a, 400, 300);
    const to = worldAt(b, 400, 300);
    for (const t of [0.1, 0.5, 0.9]) {
      const centre = worldAt(lerpTransform(a, b, t, viewport), 400, 300);
      expect(centre.x).toBeCloseTo(from.x + (to.x - from.x) * t);
      expect(centre.y).toBeCloseTo(from.y + (to.y - from.y) * t);
    }
  });

  it('handles a pure pan and a zero-size viewport', () => {
    const panned = { x: 100, y: -40, k: 0.5 };
    expect(lerpTransform(a, panned, 0.5, viewport)).toEqual({
      x: 50,
      y: -20,
      k: 0.5,
    });
    const mid = lerpTransform(a, b, 0.5, { width: 0, height: 0 });
    expect(Number.isFinite(mid.x)).toBe(true);
    expect(Number.isFinite(mid.y)).toBe(true);
    expect(mid.k).toBeCloseTo(1);
  });
});

describe('unionBox', () => {
  it('returns null for no boxes', () => {
    expect(unionBox([])).toBeNull();
  });

  it('returns a single box unchanged', () => {
    expect(unionBox([{ x: 1, y: 2, width: 3, height: 4 }])).toEqual({
      x: 1,
      y: 2,
      width: 3,
      height: 4,
    });
  });

  it('covers every box, including negative coordinates', () => {
    expect(
      unionBox([
        { x: 10, y: 10, width: 20, height: 20 },
        { x: -5, y: 40, width: 10, height: 5 },
        { x: 50, y: -15, width: 0, height: 0 },
      ])
    ).toEqual({ x: -5, y: -15, width: 55, height: 60 });
  });
});

describe('toCss', () => {
  it('formats translate then scale', () => {
    expect(toCss({ x: 12.5, y: -3, k: 1.25 })).toBe(
      'translate(12.5px, -3px) scale(1.25)'
    );
    expect(toCss(IDENTITY)).toBe('translate(0px, 0px) scale(1)');
  });
});
