import { describe, expect, test } from 'bun:test';

import { doneMeansOf, withDoneMeans } from './doneMeans';

describe('doneMeansOf', () => {
  test('reads the outcome past markdown and separators', () => {
    expect(doneMeansOf('Intro.\n- **Done means:** it ships**')).toBe(
      'it ships'
    );
    expect(doneMeansOf('Done means — a guest can pay')).toBe('a guest can pay');
  });

  test('is empty without an outcome line', () => {
    expect(doneMeansOf('Ship it.\nDone means:')).toBe('');
  });
});

describe('withDoneMeans', () => {
  test('puts a new line first when the description has none', () => {
    expect(withDoneMeans('Ship the cart.', 'a guest can pay')).toBe(
      'Done means: a guest can pay\n\nShip the cart.'
    );
    expect(withDoneMeans('', 'a guest can pay')).toBe(
      'Done means: a guest can pay'
    );
  });

  test('replaces the existing line in place, whatever its markdown', () => {
    expect(
      withDoneMeans('Intro.\n- **Done means:** old\nMore.', 'new  outcome ')
    ).toBe('Intro.\nDone means: new outcome\nMore.');
  });

  test('a blank outcome removes the line and the gap after it', () => {
    expect(withDoneMeans('Done means: old\n\nShip it.', ' ')).toBe('Ship it.');
    expect(withDoneMeans('Ship it.', '')).toBe('Ship it.');
  });

  test('leaves lines that only mention the words alone', () => {
    expect(withDoneMeans('What done means is unclear.', 'x')).toBe(
      'Done means: x\n\nWhat done means is unclear.'
    );
  });
});
