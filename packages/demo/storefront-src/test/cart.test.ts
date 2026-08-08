import { expect, test } from 'bun:test';

import { loadCart } from '../src/cart/CartProvider.js';

test('loadCart returns empty when nothing is stored', () => {
  expect(loadCart()).toEqual([]);
});
