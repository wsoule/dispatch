import { expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Radix places an `item-aligned` menu (the default this repo's SelectContent
// uses) only once the trigger has registered a value node, which is what
// `SelectValue` does. A trigger built from bare children instead renders its
// open menu unpositioned, in normal document flow at the bottom of the page —
// so the dropdown reads as "does not open" while actually being off-screen.
// Nothing catches that in a component test: the menu mounts, the options exist
// and are clickable, they are just nowhere the user can see. Hence a source
// check — the invariant is structural, so it is asserted structurally.
const SRC = join(import.meta.dir, '..');

function tsxFilesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...tsxFilesUnder(path));
    } else if (entry.endsWith('.tsx') && !entry.endsWith('.test.tsx')) {
      found.push(path);
    }
  }
  return found;
}

// The trigger's own markup, from `<SelectTrigger` to its closing tag. Returns
// one entry per trigger in the file; a self-closing trigger has no face to
// render and is skipped.
function selectTriggerBodies(source: string): string[] {
  const bodies: string[] = [];
  const opens = [...source.matchAll(/<SelectTrigger[\s>]/g)];
  for (const open of opens) {
    const from = open.index;
    const close = source.indexOf('</SelectTrigger>', from);
    if (close === -1) continue;
    bodies.push(source.slice(from, close));
  }
  return bodies;
}

test('every SelectTrigger renders its face through SelectValue', () => {
  const offenders: string[] = [];
  for (const file of tsxFilesUnder(SRC)) {
    const source = readFileSync(file, 'utf8');
    if (!source.includes('<SelectTrigger')) continue;
    for (const body of selectTriggerBodies(source)) {
      if (!body.includes('<SelectValue')) {
        offenders.push(file.slice(SRC.length + 1));
      }
    }
  }
  expect(offenders).toEqual([]);
});

// The trigger is the `SelectPill`: it must draw its face from the one shared pill
// recipe rather than a copy of it, or a select and a `SelectPill` on the same
// header drift apart the way the three hairline spellings once did.
test('SelectTrigger is built on the shared pill-button recipe', () => {
  const source = readFileSync(join(import.meta.dir, 'select.tsx'), 'utf8');
  expect(source).toContain("import { PILL_BUTTON_CLASS } from './ai/pill';");
  const trigger = source.slice(
    source.indexOf('function SelectTrigger('),
    source.indexOf('function SelectContent(')
  );
  expect(trigger).toContain('PILL_BUTTON_CLASS');
  expect(trigger).not.toContain('h-9');
  expect(trigger).not.toContain('shadow-btn');
});
