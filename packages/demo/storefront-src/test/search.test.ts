import { expect, test } from 'bun:test';

import { rank } from '../src/search/rank.js';
import { tokenize } from '../src/search/tokenize.js';

test('tokenize keeps hyphenated SKUs intact', () => {
  expect(tokenize('AB-1200 blue widget')).toEqual([
    'ab-1200',
    'blue',
    'widget',
  ]);
});

test('rank returns every product sharing a term', () => {
  const products = [
    { sku: 'AB-1200', title: 'blue widget' },
    { sku: 'CD-3400', title: 'red widget' },
  ];
  expect(
    rank('widget', products)
      .map((h) => h.sku)
      .sort()
  ).toEqual(['AB-1200', 'CD-3400']);
});
