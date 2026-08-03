import { expect, test } from 'bun:test';

const tailwind = await Bun.file(
  new URL('./tailwind.css', import.meta.url)
).text();
const tokens = await Bun.file(new URL('./tokens.css', import.meta.url)).text();

// tailwind.css used to restate tokens.css's palette as literals under shadcn's
// names, which is two sources of truth for one palette. It must only alias.
test('tailwind.css declares no hex literals', () => {
  const hexes = tailwind.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  expect(hexes).toEqual([]);
});

// The brand indigo is what this re-theme removes; if it reappears anywhere in
// the token layer the grayscale rule has been broken.
test('the Linear indigo is gone from the token layer', () => {
  expect(`${tokens}${tailwind}`.toLowerCase()).not.toContain('#5e6ad2');
});
