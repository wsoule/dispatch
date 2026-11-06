import { DEFAULT_TUNING } from '@dispatch/planning';
import { describe, expect, test } from 'bun:test';

import { milestoneMetaFrom, tuningFrom } from './planningSettings';

describe('tuningFrom', () => {
  test('is the planning default without a planning block', () => {
    expect(tuningFrom(undefined)).toEqual(DEFAULT_TUNING);
    expect(tuningFrom(undefined)).not.toBe(DEFAULT_TUNING);
  });

  test("puts config.yml's fields over the defaults", () => {
    expect(
      tuningFrom({
        tuning: { warnLeadDays: 3, activeProjectStatuses: ['started'] },
        watchers: [],
        weights: {},
        allocation: 'manual',
      })
    ).toEqual({
      ...DEFAULT_TUNING,
      warnLeadDays: 3,
      activeProjectStatuses: ['started'],
    });
  });
});

describe('milestoneMetaFrom', () => {
  test('gives each weighted milestone its weight, and no done means', () => {
    const meta = milestoneMetaFrom({
      tuning: {},
      watchers: [],
      weights: { 't-abc123': 2 },
      allocation: 'manual',
    });
    expect(meta.get('t-abc123')?.weight).toBe(2);
    expect(meta.get('t-abc123')?.doneMeans).toBeNull();
    expect(milestoneMetaFrom(undefined).size).toBe(0);
  });
});
