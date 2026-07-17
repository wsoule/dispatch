import type { Command } from 'commander';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, parseTaskFile, ConfigError } from '@dispatch/core';
import type { DispatchConfig, TaskDoc } from '@dispatch/core';
import { CliError, type CliContext } from '../context.js';
import { requireStore } from './task.js';

interface Issue { file: string; problem: string; }

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

      for (const file of readdirSync(store.tasksDir).filter(f => f.endsWith('.md'))) {
        try {
          parsed.push({ file, doc: parseTaskFile(readFileSync(join(store.tasksDir, file), 'utf8'), file) });
        } catch (err) {
          issues.push({ file, problem: (err as Error).message });
        }
      }

      const ids = new Set(parsed.map(p => p.doc.meta.id));
      for (const { file, doc } of parsed) {
        if (doc.meta.parent && !ids.has(doc.meta.parent)) {
          issues.push({ file, problem: `dangling parent: ${doc.meta.parent}` });
        }
        for (const dep of doc.meta.blockedBy) {
          if (!ids.has(dep)) issues.push({ file, problem: `dangling blocked-by: ${dep}` });
        }
        if (!config.statuses.includes(doc.meta.status)) {
          issues.push({ file, problem: `status not in config: ${doc.meta.status}` });
        }
      }

      if (opts.json) {
        ctx.log(JSON.stringify({ ok: issues.length === 0, tasks: parsed.length, issues }, null, 2));
      } else if (issues.length === 0) {
        ctx.log(`ok — ${parsed.length} task${parsed.length === 1 ? '' : 's'} checked`);
      } else {
        for (const i of issues) ctx.log(`${i.file}: ${i.problem}`);
      }
      if (issues.length > 0) {
        throw new CliError(`${issues.length} issue${issues.length === 1 ? '' : 's'} found`);
      }
    });
}
