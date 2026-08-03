import {
  ConfigError,
  findDependencyCycles,
  loadConfig,
  parseTaskFile,
} from '@dispatch/core';
import type { DispatchConfig, TaskDoc } from '@dispatch/core';
import { discoverCarto } from '@dispatch/core/carto';
import type { Command } from 'commander';
import { type Dirent, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type CliContext, CliError } from '../context.js';
import {
  checkMergeDriverSetup,
  checkTeamMergeDriverSetup,
} from '../mergeDriver.js';
import { requireStore } from './task.js';

interface Issue {
  file: string;
  problem: string;
}

const SOURCE_ROOTS = ['packages', 'apps', 'src', 'lib'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.dispatch']);

// Shallow, bounded search for any .ts/.tsx file — not a dependency graph,
// just whether the built-in scanner could find anything at all here.
function hasTypeScriptSources(rootDir: string, depth = 4): boolean {
  const search = (dir: string, left: number): boolean => {
    if (left < 0 || !existsSync(dir)) return false;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (entry.isFile() && /\.tsx?$/.test(entry.name)) return true;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
      if (search(join(dir, entry.name), left - 1)) return true;
    }
    return false;
  };
  if (search(rootDir, 0)) return true;
  return SOURCE_ROOTS.some((name) => search(join(rootDir, name), depth));
}

// Matches the ISO-8601 subset `created`/`updated` are actually written in
// (Date#toISOString, or a hand-edited offset/no-ms variant) — deliberately
// stricter than `new Date(value)`, which also accepts non-ISO formats like
// "2026/01/01" or "Jan 1 2026" that would defeat the point of this check.
const ISO_8601_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})$/;

function isIsoTimestamp(value: string): boolean {
  return ISO_8601_RE.test(value) && !Number.isNaN(Date.parse(value));
}

export function registerDoctorCommand(program: Command, ctx: CliContext): void {
  program
    .command('doctor')
    .description('Validate task files and references')
    .option('--json')
    .action((opts: { json?: boolean }) => {
      const store = requireStore(ctx);
      let config: DispatchConfig;
      try {
        config = loadConfig(ctx.cwd);
      } catch (err) {
        throw new CliError((err as ConfigError).message);
      }
      const issues: Issue[] = [];
      const parsed: { file: string; doc: TaskDoc }[] = [];

      for (const file of readdirSync(store.tasksDir).filter((f) =>
        f.endsWith('.md')
      )) {
        try {
          parsed.push({
            file,
            doc: parseTaskFile(
              readFileSync(join(store.tasksDir, file), 'utf8'),
              file
            ),
          });
        } catch (err) {
          issues.push({ file, problem: (err as Error).message });
        }
      }

      const ids = new Set(parsed.map((p) => p.doc.meta.id));

      const filesById = new Map<string, string[]>();
      for (const { file, doc } of parsed) {
        const files = filesById.get(doc.meta.id) ?? [];
        files.push(file);
        filesById.set(doc.meta.id, files);
      }
      for (const [id, files] of filesById) {
        if (files.length > 1) {
          issues.push({
            file: files[0],
            problem: `duplicate id: ${id} (${files.join(', ')})`,
          });
        }
      }

      const docsById = new Map(parsed.map((p) => [p.doc.meta.id, p.doc]));

      for (const { file, doc } of parsed) {
        if (doc.meta.parent && !ids.has(doc.meta.parent)) {
          issues.push({ file, problem: `dangling parent: ${doc.meta.parent}` });
        } else if (
          doc.meta.parent &&
          docsById.get(doc.meta.parent)?.meta.kind !== 'epic'
        ) {
          issues.push({
            file,
            problem: `parent is not an epic: ${doc.meta.parent}`,
          });
        }
        for (const dep of doc.meta.blockedBy) {
          if (dep === doc.meta.id) {
            issues.push({
              file,
              problem: `blocked-by self-reference: ${dep}`,
            });
          } else if (!ids.has(dep)) {
            issues.push({ file, problem: `dangling blocked-by: ${dep}` });
          }
        }
        if (!config.statuses.includes(doc.meta.status)) {
          issues.push({
            file,
            problem: `status not in config: ${doc.meta.status}`,
          });
        }
        for (const field of ['created', 'updated'] as const) {
          if (!isIsoTimestamp(doc.meta[field])) {
            issues.push({
              file,
              problem: `invalid ${field} timestamp: ${doc.meta[field]}`,
            });
          }
        }
      }

      for (const cycle of findDependencyCycles(parsed.map((p) => p.doc))) {
        const file = filesById.get(cycle[0])?.[0] ?? '';
        issues.push({
          file,
          problem: `dependency cycle: ${cycle.join(' → ')}`,
        });
      }

      // Absent a driver, git falls back to ordinary line conflicts on task
      // files or the team roster — degraded, not broken, but worth flagging.
      // The two halves can disagree because only .gitattributes is committed;
      // a fresh clone needs `dispatch init` re-run to pick up the local git
      // config. Only meaningful inside an actual git repo — skip it otherwise.
      if (existsSync(join(ctx.cwd, '.git'))) {
        const driver = checkMergeDriverSetup(ctx.cwd);
        if (!driver.gitattributes) {
          issues.push({
            file: '.gitattributes',
            problem: `missing merge driver line — run: dispatch init`,
          });
        }
        if (!driver.gitConfig) {
          issues.push({
            file: '.git/config',
            problem: `merge.dispatch-task driver not configured — run: dispatch init`,
          });
        }
        const teamDriver = checkTeamMergeDriverSetup(ctx.cwd);
        if (!teamDriver.gitattributes) {
          issues.push({
            file: '.gitattributes',
            problem: `missing team-roster merge driver line — run: dispatch init`,
          });
        }
        if (!teamDriver.gitConfig) {
          issues.push({
            file: '.git/config',
            problem: `merge.dispatch-team driver not configured — run: dispatch init`,
          });
        }
      }

      // Carto health, plus the empty-dependency-map warning below. Skipped
      // under --json since that output must be a single parseable blob.
      if (opts.json !== true) {
        const discovery = discoverCarto();
        if (config.carto.enabled !== 'off') {
          if (discovery.ok) {
            ctx.log(
              `carto ${discovery.binary.version} at ${discovery.binary.path}`
            );
          } else {
            ctx.log(
              `carto not available (${discovery.detail}) — using the built-in dependency scanner. Install with: npm install -g carto-md (its native deps built only under Node 22 LTS in our testing)`
            );
          }
        }
        // No carto and no TypeScript: the built-in scanner is blind here,
        // so dependents() can only ever return [].
        if (!discovery.ok && !hasTypeScriptSources(ctx.cwd)) {
          ctx.log(
            'warning: no carto container and no TypeScript sources, so the dependency map is empty and review scope covers only changed files'
          );
        }
      }

      if (opts.json === true) {
        ctx.log(
          JSON.stringify(
            { ok: issues.length === 0, tasks: parsed.length, issues },
            null,
            2
          )
        );
      } else if (issues.length === 0) {
        ctx.log(
          `ok — ${parsed.length} task${parsed.length === 1 ? '' : 's'} checked`
        );
      } else {
        for (const i of issues) ctx.log(`${i.file}: ${i.problem}`);
      }
      if (issues.length > 0) {
        throw new CliError(
          `${issues.length} issue${issues.length === 1 ? '' : 's'} found`
        );
      }
    });
}
