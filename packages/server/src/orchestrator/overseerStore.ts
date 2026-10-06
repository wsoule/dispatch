import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import type { OverseerRecord } from './overseer.js';
import { runsDir } from './paths.js';

/** Where Overseer conversations outlive the daemon. */
export interface OverseerStore {
  load(): OverseerRecord[];
  save(record: OverseerRecord): void;
}

export function overseerDir(rootDir: string): string {
  return join(runsDir(rootDir), 'overseer');
}

// Conversation ids are generated (`wc-…`); anything else on disk is not ours.
const RECORD_FILE = /^wc-[0-9a-f]+\.json$/;

/** One JSON file per conversation, written whole through a rename so a crash never leaves half a file. */
export function fileOverseerStore(dir: string): OverseerStore {
  return {
    load() {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return [];
      }
      const records: OverseerRecord[] = [];
      for (const name of names) {
        if (!RECORD_FILE.test(name)) continue;
        try {
          const record = JSON.parse(
            readFileSync(join(dir, name), 'utf8')
          ) as OverseerRecord;
          if (typeof record.id === 'string' && Array.isArray(record.messages)) {
            records.push(record);
          }
        } catch (err) {
          console.error(`overseer: skipping unreadable ${name}`, err);
        }
      }
      return records;
    },
    save(record) {
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${record.id}.json`);
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
      renameSync(tmp, path);
    },
  };
}
