import { describe, expect, test } from 'bun:test';

import { checklistLabel, readinessBadges, triageHints } from './judgmentBadges';

const reading = (level: 0 | 1 | 2 | 3, split = 0) => ({
  level,
  label: 'x',
  confidence: 0.9,
  splitProbability: split,
});

describe('readinessBadges', () => {
  test('badges only thin specs and likely splits', () => {
    expect(readinessBadges(undefined)).toEqual([]);
    expect(readinessBadges(reading(0))).toEqual(['spec: title only']);
    expect(readinessBadges(reading(1))).toEqual(['spec: no criteria']);
    expect(readinessBadges(reading(2))).toEqual([]);
    expect(readinessBadges(reading(3, 0.8))).toEqual(['split?']);
    expect(readinessBadges(reading(0, 0.7))).toEqual([
      'spec: title only',
      'split?',
    ]);
  });
});

describe('checklistLabel', () => {
  test('counts requirements and stays quiet without a checklist', () => {
    expect(checklistLabel(undefined)).toBeNull();
    expect(checklistLabel({ passed: 0, total: 0 })).toBeNull();
    expect(checklistLabel({ passed: 1, total: 1 })).toBe('1/1 requirement');
    expect(checklistLabel({ passed: 2, total: 3 })).toBe('2/3 requirements');
  });
});

describe('triageHints', () => {
  const triage = {
    itemId: 'i1',
    hash: 'h',
    kind: 'bug' as const,
    kindConfidence: 0.9,
    milestoneId: 'e1',
    milestoneTitle: 'Landing',
    milestoneConfidence: 0.9,
    duplicates: [{ id: 't-abc123', probability: 0.8 }],
  };

  test('names the re-type, the milestone and the top duplicate', () => {
    expect(triageHints({ kind: 'note' }, triage)).toEqual([
      'looks like: bug',
      '→ Landing',
      '≈ t-abc123',
    ]);
  });

  test('says nothing when the triage agrees and found nothing', () => {
    expect(
      triageHints(
        { kind: 'bug' },
        { ...triage, milestoneId: null, duplicates: [] }
      )
    ).toEqual([]);
    expect(triageHints({ kind: 'bug' }, undefined)).toEqual([]);
  });

  test('falls back to the milestone id when its title is unknown', () => {
    expect(
      triageHints(
        { kind: 'bug' },
        { ...triage, milestoneTitle: null, duplicates: [] }
      )
    ).toEqual(['→ e1']);
  });
});
