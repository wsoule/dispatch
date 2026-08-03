import { statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

// Preloaded before every test file (see bunfig.toml). `dispatch init` and
// `dispatch doctor` both call discoverCarto(), which walks PATH — but most
// test files call `init` purely as unrelated setup. Left alone, a real carto
// binary on the machine running this suite would make every one of those
// setups spawn a real `carto init` (slow, and rewrites git hooks in the temp
// repo). Scrubbing any PATH entry that holds a real `carto` binary keeps
// discoverCarto() reporting "not found" by default; tests that specifically
// need carto present prepend their own stub directory ahead of this already
// scrubbed PATH, which still wins.
function isCartoBinary(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

const originalPath = process.env.PATH ?? '';
process.env.PATH = originalPath
  .split(delimiter)
  .filter((dir) => dir !== '' && !isCartoBinary(join(dir, 'carto')))
  .join(delimiter);
