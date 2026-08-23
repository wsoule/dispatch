/**
 * Copies the desktop app's design tokens into the site so both read one palette.
 * The copy is committed: the Docker image builds apps/site standalone, without ../desktop.
 */
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(
  new URL('../../desktop/src/styles/tokens.css', import.meta.url)
);
const dest = fileURLToPath(
  new URL('../src/styles/tokens.css', import.meta.url)
);
copyFileSync(src, dest);
console.log('tokens.css synced from apps/desktop');
