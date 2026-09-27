import type { DocFileMeta, DocStatus, LinkRel } from '@dispatch/core';
import { LINK_RELS, renderDocFile } from '@dispatch/core';
import type { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import type { CliContext } from '../context.js';
import { CliError } from '../context.js';
import type { DocsApi, ImportReportInfo } from '../docsApi.js';
import { createDocsApi } from '../docsApi.js';
import { attachToRunningDaemon, resolveAppToken } from './appToken.js';

// `dispatch docs`: humans only. It authenticates with --token, DISPATCH_APP_TOKEN
// or a teammate token, never with a token an agent could read (appToken.ts).

const HEADER = /^<!-- dispatch: resolve the marked blocks[^\n]*-->\n/;

async function docsClient(
  ctx: CliContext,
  token: string | undefined
): Promise<DocsApi> {
  const appToken = resolveAppToken(token, 'dispatch docs');
  const { baseUrl } = await attachToRunningDaemon(ctx);
  return createDocsApi(baseUrl, appToken);
}

// A base-changed answer carries only the head's body, so text the caller typed
// goes beside it as one marked block instead of being overwritten.
function markedWhole(
  head: { n: number; author: string; body: string },
  mine: string
): string {
  const closed = (t: string): string =>
    t === '' || t.endsWith('\n') ? t : `${t}\n`;
  return `<<<<<<< head (rev ${head.n}, ${head.author})\n${closed(head.body)}=======\n${closed(mine)}>>>>>>> yours\n`;
}

// Opens the doc in an editor on a temp copy and saves it against the revision
// it was read at; a conflict writes the marked text back and reopens the editor.
export async function editLoop(
  api: DocsApi,
  ref: string,
  deps: {
    tmpDir: string;
    runEditor(file: string): number;
    log(line: string): void;
  }
): Promise<'saved' | 'unchanged' | 'aborted'> {
  const read = await api.get(ref);
  let base = { rev: read.rev.id, hash: read.rev.hash };
  const file = join(deps.tmpDir, `${read.doc.handle}.md`);
  // The text last put in the file, to tell whether the caller typed anything since.
  let loaded = read.text;
  writeFileSync(file, loaded);
  for (;;) {
    const code = deps.runEditor(file);
    if (code !== 0)
      throw new CliError(`the editor exited with ${code}; nothing was saved`);
    const edited = readFileSync(file, 'utf8').replace(HEADER, '');
    if (edited.trim() === '') {
      deps.log('the file is empty; nothing was saved');
      return 'aborted';
    }
    const out = await api.saveBody(ref, {
      baseRev: base.rev,
      baseHash: base.hash,
      body: edited,
    });
    if (out.ok) {
      const r = out.result;
      if (r.status === 'proposed') {
        deps.log(
          `proposed for review as ${r.proposal ?? '?'} (gate ${r.gate ?? '?'})`
        );
        return 'saved';
      }
      if (r.status !== 'unchanged') await api.seal(ref);
      deps.log(`${r.status} ${r.handle} rev ${r.rev.n ?? '-'}`);
      return r.status === 'unchanged' ? 'unchanged' : 'saved';
    }
    const c = out.conflict;
    base = { rev: c.head.id, hash: c.head.hash };
    const typed = edited !== loaded && edited !== c.head.body;
    loaded =
      c.reason === 'base-changed' && typed
        ? markedWhole(c.head, edited)
        : c.marked;
    writeFileSync(
      file,
      `<!-- dispatch: resolve the marked blocks, then save; saving against rev ${c.head.n} (${c.head.id}) -->\n${loaded}`
    );
    if (c.reason === 'merge-conflict')
      deps.log(
        `rev ${c.head.n} by ${c.head.author} changed the same lines; resolve the marked blocks and save`
      );
    else
      deps.log(
        typed
          ? 'your base changed; the file holds the newest text and yours as one marked block; resolve it and save'
          : 'your base changed; the file now holds the newest text'
      );
  }
}

// Reads files on this machine (the daemon never reads arbitrary paths) and runs
// one staged session: manifest, uploads of what the daemon needs, commit.
export async function importFiles(
  api: DocsApi,
  paths: readonly string[],
  opts: { link?: string; dryRun: boolean }
): Promise<ImportReportInfo> {
  const files = paths.map((path) => {
    const content = readFileSync(path);
    return {
      path,
      name: basename(path),
      mtime: statSync(path).mtime.toISOString(),
      bytes: content.byteLength,
      hash: createHash('sha256').update(content).digest('hex'),
      content,
    };
  });
  const { id, need } = await api.openImport(
    files.map(({ content: _content, ...f }) => f),
    opts.link
  );
  for (const hash of need) {
    const f = files.find((g) => g.hash === hash);
    if (f !== undefined) await api.putImportContent(id, hash, f.content);
  }
  try {
    return await api.commitImport(id, opts.dryRun);
  } finally {
    if (opts.dryRun) await api.deleteImport(id).catch(() => undefined);
  }
}

function printReport(ctx: CliContext, r: ImportReportInfo): void {
  ctx.log(
    `${r.dryRun ? 'dry run: ' : ''}${r.files} files, ${r.names} names, ${r.distinctContents} distinct contents`
  );
  ctx.log(
    `docs created ${r.docsCreated}, existing ${r.docsExisting}, part docs ${r.partDocsCreated}`
  );
  ctx.log(
    `contents imported ${r.contentsImported} (split ${r.splitContents}), revisions ${r.revisionsCreated}`
  );
  ctx.log(
    `duplicates ${r.duplicates}, already present ${r.alreadyPresent}, tombstoned ${r.tombstoned} (${r.tombstonedNames} names), failed names ${r.failedNames}`
  );
  for (const e of r.errors)
    ctx.log(`error: ${e.path}: ${e.reason} (${e.detail})`);
  ctx.log(
    `parity: files ${r.parity.files ? 'ok' : 'MISMATCH'}, names ${r.parity.names ? 'ok' : 'MISMATCH'}`
  );
}

// "task:t-1:spec" is a target and its rel; a target with no rel links as context.
function parseLinkOption(text: string): { target: string; rel: LinkRel } {
  const at = text.lastIndexOf(':');
  const rel =
    at > 0 ? LINK_RELS.find((r) => r === text.slice(at + 1)) : undefined;
  return rel === undefined
    ? { target: text, rel: 'context' }
    : { target: text.slice(0, at), rel };
}

// Runs $VISUAL or $EDITOR (words split, no shell) on `file`, answering its exit code.
function runEditor(file: string): number {
  const editor = [process.env.VISUAL, process.env.EDITOR].find(
    (e) => e !== undefined && e.trim() !== ''
  );
  const [cmd, ...args] = (editor ?? 'vi').trim().split(/\s+/);
  return (
    spawnSync(cmd, [...args, file], {
      stdio: 'inherit',
      shell: false,
    }).status ?? 1
  );
}

// Writes every doc the caller can see to `dir` in the receipt file format, and
// with `revHistory` each sealed revision's body under `.history/<handle>/`.
async function exportDocs(
  api: DocsApi,
  dir: string,
  revHistory: boolean
): Promise<number> {
  let offset = 0;
  let written = 0;
  for (;;) {
    const page = await api.list({ includeArchived: true, limit: 200, offset });
    for (const d of page.docs) {
      const r = await api.get(d.id);
      const history = (await api.history(d.id, 200)).revisions;
      const meta: DocFileMeta = {
        id: d.id,
        slug: d.handle,
        title: d.title,
        status: d.status,
        rev: r.rev.id,
        n: r.rev.n ?? 0,
        parents: r.rev.parents,
        author: r.rev.author,
        cause: r.rev.cause,
        createdAt: r.rev.createdAt,
        hash: r.rev.hash,
        links: r.links.map((l) => ({
          target: `${l.target.type}:${l.target.id}`,
          rel: l.rel,
        })),
        authors: [...new Set(history.map((h) => h.author))].slice(0, 20),
        updatedAt: d.updatedAt,
      };
      const sub = d.scope === 'personal' ? join(dir, 'personal') : dir;
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(sub, `${d.handle}.md`), renderDocFile(meta, r.text));
      if (revHistory) {
        const historyDir = join(dir, '.history', d.handle);
        mkdirSync(historyDir, { recursive: true });
        for (const h of history) {
          if (!h.sealed || h.n === null) continue;
          const body = (await api.revision(d.id, h.id)).body;
          writeFileSync(join(historyDir, `${h.n}.md`), body);
        }
      }
      written++;
    }
    offset += page.docs.length;
    if (page.docs.length === 0 || offset >= page.total) break;
  }
  return written;
}

export function registerDocsCommands(program: Command, ctx: CliContext): void {
  const docs = program
    .command('docs')
    .description(
      'Team documents beside tasks (humans; agents use the doc_* MCP tools)'
    );
  const tokenOpt = [
    '--token <token>',
    'the daemon app token or a teammate token (or DISPATCH_APP_TOKEN)',
  ] as const;

  docs
    .command('list')
    .description('List docs, most recently updated first')
    .option('--task <id>', "a task's linked docs, in index order")
    .option('--scope <scope>', 'team or personal')
    .option('--status <status>', 'draft, accepted or archived')
    .option('--archived', 'include archived docs')
    .option(...tokenOpt)
    .action(
      async (o: {
        task?: string;
        scope?: 'team' | 'personal';
        status?: DocStatus;
        archived?: boolean;
        token?: string;
      }) => {
        const { docs: rows } = await (
          await docsClient(ctx, o.token)
        ).list({
          taskId: o.task,
          scope: o.scope,
          status: o.status,
          includeArchived: o.archived,
        });
        for (const d of rows) {
          const flag = d.unreviewed ? ' unreviewed' : '';
          ctx.log(
            `${d.handle}\t${d.status}${flag}\trev ${d.head.n}\t${d.title}`
          );
        }
      }
    );

  docs
    .command('show <ref>')
    .description("Print a doc's outline and text")
    .option('--rev <rev>', 'a revision number or rev- id')
    .option('--section <section>', 'one section, by anchor or heading')
    .option(...tokenOpt)
    .action(
      async (
        ref: string,
        o: { rev?: string; section?: string; token?: string }
      ) => {
        const r = await (
          await docsClient(ctx, o.token)
        ).get(ref, { rev: o.rev, section: o.section });
        ctx.log(
          `${r.doc.handle} · ${r.doc.status} · rev ${r.rev.n ?? '-'} by ${r.rev.author} · ${r.doc.title}`
        );
        for (const s of r.outline)
          ctx.log(`${'  '.repeat(s.level - 1)}${s.heading} (#${s.anchor})`);
        ctx.log('');
        ctx.log(r.text);
      }
    );

  docs
    .command('cat <ref>')
    .description("Write a doc's text to stdout")
    .option('--rev <rev>', 'a revision number or rev- id')
    .option(...tokenOpt)
    .action(async (ref: string, o: { rev?: string; token?: string }) => {
      const r = await (await docsClient(ctx, o.token)).get(ref, { rev: o.rev });
      process.stdout.write(r.text);
    });

  docs
    .command('new <title>')
    .description('Create a team doc from --file or stdin')
    .option('--file <path>', 'the body; stdin when omitted')
    .option('--slug <slug>', 'the handle; derived from the title when omitted')
    .option('--scope <scope>', 'team or personal')
    .option(
      '--link <target...>',
      'task:t-1, or task:t-1:spec (spec, plan or context)'
    )
    .option(...tokenOpt)
    .action(
      async (
        title: string,
        o: {
          file?: string;
          slug?: string;
          scope?: 'team' | 'personal';
          link?: string[];
          token?: string;
        }
      ) => {
        if (o.file === undefined && process.stdin.isTTY === true)
          throw new CliError('pass --file or pipe the body on stdin');
        const body = readFileSync(o.file ?? 0, 'utf8');
        const links = (o.link ?? []).map(parseLinkOption);
        const r = await (
          await docsClient(ctx, o.token)
        ).create({ title, body, slug: o.slug, scope: o.scope, links });
        ctx.log(`created ${r.handle} rev ${r.rev.n ?? '-'}`);
      }
    );

  docs
    .command('edit <ref>')
    .description(
      'Edit a doc in $VISUAL or $EDITOR, merging with changes made meanwhile'
    )
    .option(...tokenOpt)
    .action(async (ref: string, o: { token?: string }) => {
      const api = await docsClient(ctx, o.token);
      const tmp = mkdtempSync(join(tmpdir(), 'dispatch-docs-edit-'));
      try {
        await editLoop(api, ref, {
          tmpDir: tmp,
          runEditor,
          log: (l) => ctx.log(l),
        });
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

  docs
    .command('link <ref> <target>')
    .description('Link a doc to a task, run, thread, memory entry or doc')
    .option('--rel <rel>', 'spec, plan or context', 'context')
    .option('--remove', 'remove the link instead')
    .option('--replace', "move the task's spec link to this doc")
    .option(...tokenOpt)
    .action(
      async (
        ref: string,
        target: string,
        o: { rel: LinkRel; remove?: boolean; replace?: boolean; token?: string }
      ) => {
        const api = await docsClient(ctx, o.token);
        if (o.remove === true) {
          await api.unlink(ref, target);
          ctx.log(`unlinked ${target}`);
          return;
        }
        await api.link(ref, {
          target,
          rel: o.rel,
          replace: o.replace === true,
        });
        ctx.log(`linked ${target} as ${o.rel}`);
      }
    );

  docs
    .command('history <ref>')
    .description("List a doc's revisions, newest first")
    .option(...tokenOpt)
    .action(async (ref: string, o: { token?: string }) => {
      const { revisions } = await (await docsClient(ctx, o.token)).history(ref);
      for (const r of revisions)
        ctx.log(
          `rev ${r.n ?? '-'}\t${r.cause}\t${r.author}\t${r.createdAt}\t${r.summary}`
        );
    });

  docs
    .command('diff <ref> <from> <to>')
    .description('Show the lines that changed between two revisions')
    .option(...tokenOpt)
    .action(
      async (ref: string, from: string, to: string, o: { token?: string }) => {
        const { chunks } = await (
          await docsClient(ctx, o.token)
        ).diff(ref, from, to);
        for (const c of chunks) {
          if (c.equal) continue;
          for (const l of c.a) ctx.log(`-${l.replace(/\n$/, '')}`);
          for (const l of c.b) ctx.log(`+${l.replace(/\n$/, '')}`);
        }
      }
    );

  docs
    .command('revert <ref> <rev>')
    .description("Save an earlier revision's text as a new revision")
    .option(...tokenOpt)
    .action(async (ref: string, rev: string, o: { token?: string }) => {
      const r = await (await docsClient(ctx, o.token)).revert(ref, rev);
      ctx.log(`${r.status} ${r.handle} rev ${r.rev.n ?? '-'}`);
    });

  for (const [name, status, what] of [
    ['archive', 'archived', 'Archive a doc (read-only until restored)'],
    ['restore', 'draft', 'Restore an archived doc'],
  ] as const) {
    docs
      .command(`${name} <ref>`)
      .description(what)
      .option(...tokenOpt)
      .action(async (ref: string, o: { token?: string }) => {
        const r = await (await docsClient(ctx, o.token)).setStatus(ref, status);
        ctx.log(`${ref}: ${r.status}`);
      });
  }

  docs
    .command('reviewed <ref>')
    .description("Mark a doc's head reviewed")
    .option(...tokenOpt)
    .action(async (ref: string, o: { token?: string }) => {
      await (await docsClient(ctx, o.token)).reviewed(ref);
      ctx.log(`${ref}: reviewed`);
    });

  docs
    .command('delete <ref>')
    .description('Delete a doc and its history')
    .option(...tokenOpt)
    .action(async (ref: string, o: { token?: string }) => {
      await (await docsClient(ctx, o.token)).remove(ref);
      ctx.log(`${ref}: deleted`);
    });

  docs
    .command('import <files...>')
    .description(
      'Import markdown files, with a count-parity report (decide tier)'
    )
    .option('--link <target>', 'link every imported doc as context')
    .option('--dry-run', 'report without writing')
    .option(...tokenOpt)
    .action(
      async (
        files: string[],
        o: { link?: string; dryRun?: boolean; token?: string }
      ) => {
        const report = await importFiles(
          await docsClient(ctx, o.token),
          files,
          { link: o.link, dryRun: o.dryRun === true }
        );
        printReport(ctx, report);
        if (!report.parity.files || !report.parity.names)
          throw new CliError('parity mismatch; nothing was imported');
      }
    );

  docs
    .command('export <dir>')
    .description('Write every doc you can see to <dir> as markdown files')
    .option('--rev-history', 'also write every sealed revision')
    .option(...tokenOpt)
    .action(
      async (dir: string, o: { revHistory?: boolean; token?: string }) => {
        const api = await docsClient(ctx, o.token);
        const written = await exportDocs(api, dir, o.revHistory === true);
        ctx.log(`exported ${written} docs to ${dir}`);
      }
    );
}
