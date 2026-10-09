import { expect, test } from 'bun:test';

import { shortPath } from './ProjectSwitcher';

test('the home folder reads as ~', () => {
  expect(shortPath('/Users/ada/Sites/storefront')).toBe('~/Sites/storefront');
  expect(shortPath('/home/ada/code/app')).toBe('~/code/app');
  expect(shortPath('/Users/ada')).toBe('~');
});

test('paths outside a home folder are left alone', () => {
  expect(shortPath('/srv/repo')).toBe('/srv/repo');
  expect(shortPath('/Users')).toBe('/Users');
});
