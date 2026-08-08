import { expect, test } from 'bun:test';

import { applyDiscount } from '../src/checkout/discount.js';

test('a known code reduces the subtotal', () => {
  expect(applyDiscount('WELCOME10', 100)).toBe(90);
});

test('an unknown code leaves the subtotal alone', () => {
  expect(applyDiscount('NOPE', 100)).toBe(100);
});
