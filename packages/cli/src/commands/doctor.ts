import {
  ConfigError,
  findDependencyCycles,
  loadConfig,
  parseTaskFile,
} from '@dispatch/core';
import type { DispatchConfig, TaskDoc } from '@dispatch/core';
import { checkCartoHealth, discoverCarto } from '@dispatch/core/carto';
import type { Command } from 'commander';
import { type Dirent, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createTaskApiClient } from '../apiClient.js';
import { type CliContext, CliError } from '../context.js';
import {
  checkMergeDriverSetup,
  checkTeamMergeDriverSetup,
} from '../mergeDriver.js';
import { findRunningDaemon } from './daemon.js';
import { databaseBacked, projectRoot, requireStore } from './task.js';

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

/**
 * Whether doctor should read the board from the daemon's database.
 *
 * Keyed purely on the recorded backend. It used to also require that
 * `.dispatch/tasks` was absent — but the import COPIES and never deletes, so
 * that directory survives the migration, and until the retire-originals task
 * lands it survives indefinitely. The effect was that doctor permanently
 * validated a frozen snapshot of the markdown instead of the live board:
 * every task created after the migration invisible to it, and every stale
 * reference in the leftover files reported as a live problem.
 *
 * Once a project has recorded `sqlite`, the database IS the board, whatever
 * else is still sitting on disk beside it.
 */
function databaseBackedBoard(ctx: CliContext): boolean {
  return databaseBacked(projectRoot(ctx.cwd));
}

export function registerDoctorCommand(program: Command, ctx: CliContext): void {
  program
    .command('doctor')
    .description('Validate task files and references')
    .option('--json')
    .action(async (opts: { json?: boolean }) => {
      // Where this project's tasks come from. Only the PARSE checks are
      // file-specific — malformed frontmatter, two files claiming one id —
      // and a database genuinely cannot express those. Every check after
      // them is about the task GRAPH (dangling parents, dangling blocked-by,
      // cycles, unknown statuses), and the schema does not enforce any of
      // that: `blocked_by` is a JSON text column with no foreign key behind
      // it, so a database can hold exactly the same broken graph a folder of
      // markdown can. Those checks therefore run on both backends, reading
      // through the daemon when it owns the store.
      const fromDatabase = databaseBackedBoard(ctx);
      const tasksDir = fromDatabase ? null : requireStore(ctx).tasksDir;
      let config: DispatchConfig;
      try {
        config = loadConfig(ctx.cwd);
      } catch (err) {
        throw new CliError((err as ConfigError).message);
      }
      const issues: Issue[] = [];
      const parsed: { file: string; doc: TaskDoc }[] = [];

      if (tasksDir !== null) {
        for (const file of readdirSync(tasksDir).filter((f) =>
          f.endsWith('.md')
        )) {
          try {
            parsed.push({
              file,
              doc: parseTaskFile(
                readFileSync(join(tasksDir, file), 'utf8'),
                file
              ),
            });
          } catch (err) {
            issues.push({ file, problem: (err as Error).message });
          }
        }
      } else {
        // The daemon is the only process that may read this store, so there
        // is nothing to check without one. `file` carries the task id here,
        // which is what every issue message below quotes — a database-backed
        // project has no filename to name instead.
        const daemon = await findRunningDaemon(projectRoot(ctx.cwd)).catch(
          () => null
        );
        if (daemon === null) {
          throw new CliError(
            'dispatchd is not running — this project keeps its tasks in the ' +
              "daemon's database, which only dispatchd may read. Start it " +
              'with: dispatch serve'
          );
        }
        const api = createTaskApiClient(
          `http://127.0.0.1:${daemon.port}`,
          daemon.agentToken
        );
        for (const doc of await api.listTasks()) {
          parsed.push({ file: doc.meta.id, doc });
        }
        // Records the daemon could not read at all never reach listTasks(),
        // so without this they are invisible to doctor and it reports a clean
        // board over a damaged one. On the file backend the equivalent
        // failures surface as parse errors in the loop above; on the database
        // backend `GET /api/health` is the only place they are named.
        for (const problem of await api.healthProblems()) {
          issues.push({ file: problem.split(':')[0] ?? '', problem });
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
        // A carto that answers `--version` can still be unusable: that probe
        // loads none of its native modules, so bindings that never built
        // surface only when something actually indexes. `carto doctor` does
        // load them, which is why the version line alone isn't the verdict.
        const health = discovery.ok
          ? checkCartoHealth(ctx.cwd, discovery.binary)
          : null;
        const broken = health !== null && !health.ok;
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
          if (health !== null && !health.ok) {
            if (health.reason === 'unhealthy') {
              ctx.log(
                'warning: carto is installed but not working — using the built-in dependency scanner until these are fixed:'
              );
              for (const failure of health.failures) {
                const fix = failure.fix === null ? '' : ` — ${failure.fix}`;
                ctx.log(`  ${failure.label}: ${failure.detail}${fix}`);
              }
            } else {
              ctx.log(`carto health check unavailable (${health.detail})`);
            }
          }
        }
        // No usable carto and no TypeScript: the built-in scanner is blind
        // here, so dependents() can only ever return [].
        if ((!discovery.ok || broken) && !hasTypeScriptSources(ctx.cwd)) {
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
        // What was checked is a different question from whether it was clean:
        // this branch is only reached once there are no issues, so the
        // wording can never contradict a non-zero issue count below.
        const count = `${parsed.length} task${parsed.length === 1 ? '' : 's'}`;
        ctx.log(
          fromDatabase
            ? `ok — ${count} checked from the daemon database`
            : `ok — ${count} checked`
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
