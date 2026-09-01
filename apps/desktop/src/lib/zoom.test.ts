import { describe, expect, test } from 'bun:test';

import { stepZoomFactor, ZOOM_MAX, ZOOM_MIN } from './zoom';

describe('stepZoomFactor', () => {
  test('steps by 0.1 in each direction and resets to 1', () => {
    expect(stepZoomFactor(1, 'in')).toBe(1.1);
    expect(stepZoomFactor(1, 'out')).toBe(0.9);
    expect(stepZoomFactor(1.3, 'reset')).toBe(1);
  });

  test('clamps at the range ends', () => {
    expect(stepZoomFactor(ZOOM_MAX, 'in')).toBe(ZOOM_MAX);
    expect(stepZoomFactor(ZOOM_MIN, 'out')).toBe(ZOOM_MIN);
  });

  test('repeated steps land on clean one-decimal factors', () => {
    // 0.1 increments drift in float math (1.1 + 0.1 === 1.2000000000000002)
    // without the rounding step.
    let factor = 1;
    for (let i = 0; i < 3; i++) factor = stepZoomFactor(factor, 'in');
    expect(factor).toBe(1.3);
  });
});
