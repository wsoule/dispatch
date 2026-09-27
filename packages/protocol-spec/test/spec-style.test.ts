import { expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';

import { SPEC_DIR } from '../src/sections.js';

it('uses no em-dash anywhere in spec/ (the site forbids them)', () => {
  for (const file of readdirSync(SPEC_DIR)) {
    const text = readFileSync(new URL(file, SPEC_DIR), 'utf8');
    expect({ file, emDash: text.includes('—') }).toEqual({
      file,
      emDash: false,
    });
  }
});
