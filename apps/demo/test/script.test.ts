import { describe, expect, test } from 'bun:test';

import {
  buildStorefrontRunScript,
  STOREFRONT_PLAN_PROPOSAL,
} from '../src/script.js';

describe('storefront demo script', () => {
  test('is a paced, terminal script with one approval gate and a real write', () => {
    const script = buildStorefrontRunScript();
    const steps = script.steps ?? [];
    expect(steps.length).toBeGreaterThanOrEqual(5);
    expect(steps.filter((s) => s.approval !== undefined).length).toBe(1);
    expect(steps.some((s) => s.write !== undefined)).toBe(true);
    expect(steps.some((s) => (s.delayMs ?? 0) >= 1000)).toBe(true);
    expect(script.finish.state).toBe('finished');
  });

  test('plan proposal has an epic and ordered tasks', () => {
    expect(STOREFRONT_PLAN_PROPOSAL.epic?.title.length).toBeGreaterThan(0);
    expect(STOREFRONT_PLAN_PROPOSAL.tasks.length).toBeGreaterThanOrEqual(2);
  });
});
