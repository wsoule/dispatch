import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { FormatError, parseVectorFile } from './format.js';
import { VECTOR_CLASSES } from './types.js';
import type { Vector, VectorFile } from './types.js';

export const VECTORS_DIR = new URL('../vectors/', import.meta.url);

const RETIRED = 'retired.json';

type Retired = { id: string; reason: string };

// A directory URL that ends in a slash, so relative lookups stay inside it.
function directoryUrl(dir: URL | string): URL {
  if (typeof dir === 'string') return pathToFileURL(resolve(dir) + sep);
  return dir.pathname.endsWith('/') ? dir : new URL(`${dir.href}/`);
}

function readJson(url: URL, where: string): unknown {
  try {
    return JSON.parse(readFileSync(url, 'utf8'));
  } catch (err) {
    throw new FormatError(
      `${where}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function parseRetired(raw: unknown): Retired[] {
  const list =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as { retired?: unknown }).retired
      : undefined;
  if (!Array.isArray(list))
    throw new FormatError(`${RETIRED}: retired must be a list`);
  return list.map((r: unknown, i) => {
    const e = (typeof r === 'object' && r !== null ? r : {}) as Record<
      string,
      unknown
    >;
    const { id, reason } = e;
    if (typeof id !== 'string' || typeof reason !== 'string' || reason === '')
      throw new FormatError(`${RETIRED}: retired[${i}] must be { id, reason }`);
    return { id, reason };
  });
}

// Reads `retired.json`, then each class directory's `*.json` in name order,
// refusing a stray directory, a misfiled class and a reused or retired id.
export function loadVectors(dir: URL | string = VECTORS_DIR): {
  files: VectorFile[];
  vectors: Vector[];
  retired: { id: string; reason: string }[];
} {
  const root = directoryUrl(dir);
  const retiredUrl = new URL(RETIRED, root);
  const retired = existsSync(retiredUrl)
    ? parseRetired(readJson(retiredUrl, RETIRED))
    : [];
  const classes: readonly string[] = VECTOR_CLASSES;
  const stray = readdirSync(root).find(
    (name) =>
      !name.startsWith('.') && name !== RETIRED && !classes.includes(name)
  );
  if (stray !== undefined)
    throw new FormatError(
      `${stray}: not a vector class (${VECTOR_CLASSES.join(', ')}) or ${RETIRED}`
    );
  const seen = new Map<string, string>(retired.map((r) => [r.id, RETIRED]));
  const files: VectorFile[] = [];
  for (const cls of VECTOR_CLASSES) {
    const classDir = new URL(`${cls}/`, root);
    if (!existsSync(classDir)) continue;
    const names = readdirSync(classDir)
      .filter((f) => f.endsWith('.json'))
      .sort();
    for (const name of names) {
      const where = `${cls}/${name}`;
      const file = parseVectorFile(
        readJson(new URL(name, classDir), where),
        where
      );
      if (file.class !== cls)
        throw new FormatError(
          `${where}: class ${file.class} is not its directory ${cls}`
        );
      for (const v of file.vectors) {
        const first = seen.get(v.id);
        if (first === RETIRED)
          throw new FormatError(`${where}: ${v.id}: id is retired`);
        if (first !== undefined)
          throw new FormatError(
            `${where}: ${v.id}: duplicate id, first used in ${first}`
          );
        seen.set(v.id, where);
      }
      files.push(file);
    }
  }
  return { files, vectors: files.flatMap((f) => f.vectors), retired };
}
