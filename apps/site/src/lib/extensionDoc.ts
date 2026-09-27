import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const EXTENSION_NAMES = ['envelope', 'gate', 'work'] as const;
export type ExtensionName = (typeof EXTENSION_NAMES)[number];

// The build runs in apps/site (moon's project cwd), so the package doc is two levels up.
const DOC = resolve(process.cwd(), '../../packages/a2a/docs/extensions.md');

// One extension's normative text: what sits between its ext markers in the doc.
export function extensionSection(name: ExtensionName): string {
  const text = readFileSync(DOC, 'utf8');
  const open = `<!-- ext:${name} -->`;
  const start = text.indexOf(open);
  const end = text.indexOf(`<!-- /ext:${name} -->`);
  if (start === -1 || end === -1)
    throw new Error(`extensions.md has no ${name} section`);
  return text.slice(start + open.length, end).trim();
}
