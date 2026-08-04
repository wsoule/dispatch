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

// The brand indigo as a chrome accent is what this re-theme removes: --accent
// must stay a neutral contrast color, not a hue. (A `--violet` token reusing
// this hex is fine — it's meaning color for the working run state, not chrome.)
test('--accent is not the Linear indigo', () => {
  const accentLines = tokens
    .split('\n')
    .filter((line) => /--accent:\s*/.test(line));
  expect(accentLines.length).toBeGreaterThan(0);
  for (const line of accentLines) {
    expect(line.toLowerCase()).not.toContain('#5e6ad2');
  }
});
