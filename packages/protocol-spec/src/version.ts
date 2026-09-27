import { readFileSync } from 'node:fs';

// The kit's own package.json, from src/ in tests and dist/ when published.
const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
) as { name: string; version: string };
export const KIT_VERSION: string = pkg.version;
export const KIT_NAME: string = pkg.name;
