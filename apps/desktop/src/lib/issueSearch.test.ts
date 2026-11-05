import { describe, expect, test } from 'bun:test';

import { filterBySearch, matchesIssueSearch, searchWords } from './issueSearch';
import { taskDoc } from './taskDoc.test-helper';

const cart = taskDoc({
  id: 't-cart',
  title: 'Persist the cart across devices',
  labels: ['ui', 'storage'],
});
const search = taskDoc({ id: 't-search', title: 'Rate limit the search' });

describe('searchWords', () => {
  test('lower-cases and splits on whitespace, dropping blanks', () => {
    expect(searchWords('  Cart  UI ')).toEqual(['cart', 'ui']);
    expect(searchWords('')).toEqual([]);
  });
});

describe('matchesIssueSearch', () => {
  test('no words matches everything', () => {
    expect(matchesIssueSearch(cart, [])).toBe(true);
  });

  test('every word must hit the title, id, key or a label', () => {
    expect(matchesIssueSearch(cart, ['cart'])).toBe(true);
    expect(matchesIssueSearch(cart, ['t-cart'])).toBe(true);
    expect(matchesIssueSearch(cart, ['storage'])).toBe(true);
    expect(matchesIssueSearch(cart, ['eng-12'], 'ENG-12')).toBe(true);
    expect(matchesIssueSearch(cart, ['cart', 'devices'])).toBe(true);
    expect(matchesIssueSearch(cart, ['cart', 'search'])).toBe(false);
    expect(matchesIssueSearch(search, ['cart'])).toBe(false);
  });
});

describe('filterBySearch', () => {
  test('a blank query returns the same array', () => {
    const tasks = [cart, search];
    expect(filterBySearch(tasks, '   ')).toBe(tasks);
  });

  test('keeps the matching tasks, reading the key through keyOf', () => {
    const tasks = [cart, search];
    expect(filterBySearch(tasks, 'limit')).toEqual([search]);
    expect(
      filterBySearch(tasks, 'eng-7', (doc) =>
        doc.meta.id === 't-search' ? 'ENG-7' : undefined
      )
    ).toEqual([search]);
    expect(filterBySearch(tasks, 'nothing here')).toEqual([]);
  });
});
