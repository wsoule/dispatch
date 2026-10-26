import { describe, expect, test } from 'bun:test';

import {
  foldedTitles,
  foldText,
  indexWorkspace,
  issueSearchScore,
  issueSearchTerms,
} from '../src/index';
import { issue, workspace } from './helpers';

const reconcile = issue('iss-24', {
  identifier: 'ENG-24',
  title: 'Reconcile the Résumé export',
});
const engine = issue('iss-7', {
  identifier: 'ENG-7',
  title: 'Engine warm-up',
});
const ops = issue('iss-240', {
  identifier: 'OPS-240',
  title: 'Rotate keys',
});

function score(
  query: string,
  target = reconcile,
  options?: { identifier?: boolean }
): 0 | 1 | 2 | 3 | null {
  return issueSearchScore(
    target,
    issueSearchTerms(query),
    foldText(target.title),
    options
  );
}

describe('foldText and issueSearchTerms', () => {
  test('folds case and diacritics', () => {
    expect(foldText('Résumé ÉCOLE')).toBe('resume ecole');
  });

  test('trims, folds and splits on whitespace', () => {
    expect(issueSearchTerms('  Résumé   Export ')).toEqual({
      folded: 'resume   export',
      words: ['resume', 'export'],
    });
    expect(issueSearchTerms('   ')).toEqual({ folded: '', words: [] });
  });
});

describe('issueSearchScore', () => {
  test('identifier exact, prefix and contains ("24" finds ENG-24)', () => {
    expect(score('eng-24')).toBe(0);
    expect(score('ENG-2')).toBe(1);
    expect(score('24')).toBe(2);
    expect(score('24', ops)).toBe(2);
  });

  test('every title word, accent-folded, in any order', () => {
    expect(score('resume reconcile')).toBe(3);
    expect(score('RÉSUMÉ')).toBe(3);
    expect(score('resume import')).toBe(null);
  });

  test('identifier: false skips the identifier ("eng" matches titles only)', () => {
    expect(score('eng', reconcile)).toBe(1);
    expect(score('eng', reconcile, { identifier: false })).toBe(null);
    expect(score('eng', engine, { identifier: false })).toBe(3);
    expect(score('eng-24', reconcile, { identifier: false })).toBe(null);
  });

  test('an empty query matches everything with 3', () => {
    expect(score('')).toBe(3);
    expect(score('  ', ops, { identifier: false })).toBe(3);
  });
});

describe('foldedTitles', () => {
  test('folds every title once per snapshot', () => {
    const snapshot = indexWorkspace(
      workspace({ issues: [reconcile, engine, ops] })
    );
    const titles = foldedTitles(snapshot);
    expect(titles.get('iss-24')).toBe('reconcile the resume export');
    expect(titles.size).toBe(3);
    // The same map object for the same snapshot: computed once.
    expect(foldedTitles(snapshot)).toBe(titles);
    // A new snapshot (a new mirror version) gets its own.
    const next = indexWorkspace(workspace({ issues: [reconcile] }));
    expect(foldedTitles(next)).not.toBe(titles);
    expect(foldedTitles(next).size).toBe(1);
  });
});
