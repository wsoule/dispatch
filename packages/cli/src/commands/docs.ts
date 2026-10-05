import type {
  DocFileMeta,
  DocRevisionInfo,
  DocScope,
  DocStatus,
  LinkRel,
} from '@dispatch-foo/core';
import {
  assetNames,
  childEnv,
  LINK_RELS,
  parseDocFile,
  renderDocFile,
  rewriteAssetLinks,
} from '@dispatch-foo/core';
import type { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';

import type { CliContext } from '../context.js';
import { CliError } from '../context.js';
import type { DocsApi, ImportReportInfo } from '../docsApi.js';
import { createDocsApi } from '../docsApi.js';
import { attachToRunningDaemon, resolveAppToken } from './appToken.js';

// `dispatch docs`: humans only. It authenticates with --token, DISPATCH_APP_TOKEN
// or a teammate token, never with a token an agent could read (appToken.ts).

const HEADER = /^<!-- dispatch: resolve the marked blocks[^\n]*-->\n/;

// A doc's handle as the caller types it back: ~slug for a personal doc.
const writtenHandle = (d: { scope: DocScope; handle: string }): string =>
  d.scope === 'personal' ? `~${d.handle}` : d.handle;

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
      deps.log(`${r.status} ${writtenHandle(r.doc)} rev ${r.rev.n ?? '-'}`);
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

// The name an import groups a file under, as the daemon keys it.
const importName = (path: string): string =>
  basename(path).replace(/\.md$/i, '');

// Adds paths this machine could not read to the daemon's report as errors,
// counting a name only they carry as failed, so both identities still hold.
function withUnread(
  report: ImportReportInfo,
  unread: readonly { path: string; detail: string }[],
  sent: readonly string[]
): ImportReportInfo {
  if (unread.length === 0) return report;
  const known = new Set(sent.map(importName));
  const errors = [...report.errors];
  let failedNames = 0;
  for (const u of unread) {
    errors.push({ path: u.path, reason: 'missing', detail: u.detail });
    const name = importName(u.path);
    if (known.has(name)) continue;
    known.add(name);
    failedNames++;
  }
  return {
    ...report,
    files: report.files + unread.length,
    names: report.names + failedNames,
    failedNames: report.failedNames + failedNames,
    errors,
  };
}

// An exported image link: `![alt](<rel>/assets/<doc id>/<asset name>)`.
const EXPORTED_IMAGE =
  /!\[([^\]]*)\]\(([^)\s]*?assets\/(doc-[0-9A-Z]{26})\/([0-9a-f]{64}\.(?:png|jpg|gif|webp)))\)/g;

// Points an exported doc's image links back at `asset:`, reading each image
// its own assets/<doc id>/ folder holds; the names with no bytes are missing.
function importedImages(
  path: string,
  docId: string,
  text: string
): { text: string; bytes: Map<string, Uint8Array>; missing: string[] } {
  const bytes = new Map<string, Uint8Array>();
  const missing = new Set<string>();
  const rewritten = text.replace(
    EXPORTED_IMAGE,
    (whole, alt: string, target: string, owner: string, name: string) => {
      if (owner !== docId) return whole;
      try {
        bytes.set(
          name,
          new Uint8Array(readFileSync(join(dirname(path), target)))
        );
      } catch {
        missing.add(name);
      }
      return `![${alt}](asset:${name})`;
    }
  );
  for (const name of assetNames(rewritten))
    if (!bytes.has(name)) missing.add(name);
  return { text: rewritten, bytes, missing: [...missing] };
}

// Uploads each image a committed name's docs link, from the files it was read
// from; answers how many distinct images reached the daemon.
async function uploadImages(
  api: DocsApi,
  report: ImportReportInfo,
  images: ReadonlyMap<string, ReadonlyMap<string, Uint8Array>>
): Promise<number> {
  const uploaded = new Set<string>();
  for (const { name, docs } of report.docs ?? []) {
    const held = images.get(name);
    if (held === undefined || held.size === 0) continue;
    for (const doc of docs) {
      const text = (await api.get(doc)).text;
      for (const ref of assetNames(text)) {
        const bytes = held.get(ref);
        if (bytes === undefined) continue;
        const stored = await api.putAsset(doc, bytes);
        if (stored.name === ref) uploaded.add(ref);
      }
    }
  }
  return uploaded.size;
}

// Reads files on this machine (the daemon never reads arbitrary paths) and runs
// one staged session: manifest, uploads of what the daemon needs, commit.
export async function importFiles(
  api: DocsApi,
  paths: readonly string[],
  opts: { link?: string; dryRun: boolean }
): Promise<ImportReportInfo> {
  const unread: { path: string; detail: string }[] = [];
  const images = new Map<string, Map<string, Uint8Array>>();
  const missingImages: { path: string; detail: string }[] = [];
  let referenced = 0;
  const files = paths.flatMap((path) => {
    try {
      let raw = readFileSync(path);
      // A receipts or export file: sent whole (the daemon reads its
      // frontmatter), under its own slug and time.
      const parsed = parseDocFile(raw.toString('utf8'));
      const doc = 'error' in parsed ? null : parsed;
      // An exported doc in its export's personal/ folder is someone's private
      // doc: never sent. A plain note in any other personal/ folder is a file.
      if (
        doc !== null &&
        (doc.meta.scope === 'personal' ||
          basename(dirname(realpathSync(path))).toLowerCase() === 'personal')
      ) {
        unread.push({ path, detail: 'personal docs are never imported' });
        return [];
      }
      if (doc !== null) {
        const found = importedImages(path, doc.meta.id, raw.toString('utf8'));
        raw = Buffer.from(found.text, 'utf8');
        images.set(doc.meta.slug, found.bytes);
        referenced += found.bytes.size + found.missing.length;
        for (const name of found.missing)
          missingImages.push({ path, detail: `image ${name} was not found` });
      }
      return [
        {
          path,
          name: doc === null ? basename(path) : `${doc.meta.slug}.md`,
          mtime:
            doc === null
              ? statSync(path).mtime.toISOString()
              : doc.meta.updatedAt,
          bytes: raw.byteLength,
          hash: createHash('sha256').update(raw).digest('hex'),
          content: raw,
        },
      ];
    } catch (err) {
      unread.push({ path, detail: (err as Error).message });
      return [];
    }
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
    const report = await api.commitImport(id, opts.dryRun);
    const uploaded = opts.dryRun ? 0 : await uploadImages(api, report, images);
    const held = [...images.values()].reduce((n, m) => n + m.size, 0);
    const missing = missingImages.length + (opts.dryRun ? 0 : held - uploaded);
    const withImages: ImportReportInfo = {
      ...report,
      errors:
        missingImages.length === 0
          ? report.errors
          : [
              ...report.errors,
              ...missingImages.map((m) => ({
                ...m,
                reason: 'missing' as const,
              })),
            ],
      parity: { ...report.parity, images: missing === 0 },
      images: { referenced, uploaded, missing },
    };
    return withUnread(
      withImages,
      unread,
      files.map((f) => f.path)
    );
  } finally {
    if (opts.dryRun) await api.deleteImport(id).catch(() => undefined);
  }
}

// Fails the import command on a parity mismatch, or when an image is missing.
export function checkImportReport(r: ImportReportInfo): void {
  if (!r.parity.files || !r.parity.names)
    throw new CliError('parity mismatch; nothing was imported');
  if (r.parity.images === false)
    throw new CliError(
      `${r.images?.missing ?? 0} image(s) missing; the docs were imported without them`
    );
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
  const images =
    r.images === undefined
      ? ''
      : `, images ${r.images.missing === 0 ? 'ok' : `${r.images.missing} MISSING`} (${r.images.uploaded} of ${r.images.referenced} uploaded)`;
  ctx.log(
    `parity: files ${r.parity.files ? 'ok' : 'MISMATCH'}, names ${r.parity.names ? 'ok' : 'MISMATCH'}${images}`
  );
}

const LIST_PAGE = 200;

// Accepts every doc a receipts restore brought back as a former accepted doc,
// answering their ids; a restored doc is trusted as accepted only once a human says so.
export async function acceptRestored(api: DocsApi): Promise<string[]> {
  const restored: string[] = [];
  for (let offset = 0; ; ) {
    const page = await api.list({ limit: LIST_PAGE, offset });
    for (const d of page.docs)
      if (d.restored?.status === 'accepted') restored.push(d.id);
    offset += page.docs.length;
    if (page.docs.length === 0 || offset >= page.total) break;
  }
  for (const id of restored) await api.setStatus(id, 'accepted');
  return restored;
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
      env: childEnv(),
      stdio: 'inherit',
      shell: false,
    }).status ?? 1
  );
}

const HISTORY_PAGE = 200;

// Every numbered revision of a doc, newest first, a page at a time.
async function allRevisions(
  api: DocsApi,
  id: string
): Promise<DocRevisionInfo[]> {
  const out: DocRevisionInfo[] = [];
  for (;;) {
    const before = out.at(-1)?.n ?? undefined;
    const page = (await api.history(id, HISTORY_PAGE, before)).revisions;
    out.push(...page);
    const last = page.at(-1);
    if (page.length < HISTORY_PAGE || last === undefined || last.n === null)
      return out;
  }
}

// Distinct authors of the head and its ancestors, newest first, at most 20.
function ancestryAuthors(
  head: DocRevisionInfo,
  revisions: readonly DocRevisionInfo[]
): string[] {
  const all = [head, ...revisions];
  const byId = new Map(all.map((r) => [r.id, r]));
  const ancestry = new Set<string>();
  const stack = [head.id];
  for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
    if (ancestry.has(id)) continue;
    ancestry.add(id);
    stack.push(...(byId.get(id)?.parents ?? []));
  }
  const authors = new Set(
    all.filter((r) => ancestry.has(r.id)).map((r) => r.author)
  );
  return [...authors].slice(0, 20);
}

// Writes every doc the caller can see to `dir` (personal ones under `personal/`)
// in the receipt file format; `revHistory` adds sealed revisions in `.history/<handle>/`.
// Doc ids are `doc-` and a ULID; one names a directory only once it matches.
const EXPORT_DOC_ID = /^doc-[0-9A-Z]{26}$/;

// Copies each image `text` references to <dir>/assets/<doc id>/ and points its
// link there, relative to the doc's own folder; one the daemon lacks keeps its link.
async function exportImages(
  api: DocsApi,
  dir: string,
  sub: string,
  docId: string,
  text: string
): Promise<string> {
  const names = assetNames(text);
  if (names.length === 0 || !EXPORT_DOC_ID.test(docId)) return text;
  const assetsDir = join(dir, 'assets', docId);
  const copied = new Set<string>();
  for (const name of names) {
    const bytes = await api.asset(docId, name);
    if (bytes === null) continue;
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, name), bytes);
    copied.add(name);
  }
  const rel = relative(sub, assetsDir).split(sep).join('/');
  return rewriteAssetLinks(text, (n) =>
    copied.has(n) ? `${rel}/${n}` : `asset:${n}`
  );
}

export async function exportDocs(
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
      const history = await allRevisions(api, d.id);
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
        authors: ancestryAuthors(r.rev, history),
        updatedAt: d.updatedAt,
        // Names a personal doc as one, so no import takes it for a team doc.
        scope: d.scope,
      };
      const sub = d.scope === 'personal' ? join(dir, 'personal') : dir;
      mkdirSync(sub, { recursive: true });
      const text = await exportImages(api, dir, sub, d.id, r.text);
      writeFileSync(join(sub, `${d.handle}.md`), renderDocFile(meta, text));
      if (revHistory) {
        const historyDir = join(sub, '.history', d.handle);
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
            `${writtenHandle(d)}\t${d.status}${flag}\trev ${d.head.n}\t${d.title}`
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
          `${writtenHandle(r.doc)} · ${r.doc.status} · rev ${r.rev.n ?? '-'} by ${r.rev.author} · ${r.doc.title}`
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
        ctx.log(`created ${writtenHandle(r.doc)} rev ${r.rev.n ?? '-'}`);
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
      ctx.log(`${r.status} ${writtenHandle(r.doc)} rev ${r.rev.n ?? '-'}`);
    });

  docs
    .command('accept [ref]')
    .description(
      'Accept a doc: agents then propose edits instead of writing it (decide tier)'
    )
    .option('--restored', 'accept every doc restored as a former accepted doc')
    .option(...tokenOpt)
    .action(
      async (
        ref: string | undefined,
        o: { restored?: boolean; token?: string }
      ) => {
        const api = await docsClient(ctx, o.token);
        if (o.restored === true) {
          const ids = await acceptRestored(api);
          ctx.log(`accepted ${ids.length} restored docs`);
          return;
        }
        if (ref === undefined)
          throw new CliError('name a doc to accept, or pass --restored');
        const r = await api.setStatus(ref, 'accepted');
        ctx.log(`${ref}: ${r.status}`);
      }
    );

  docs
    .command('proposals')
    .description('List proposed edits to accepted docs you may see')
    .option('--doc <ref>', "one doc's proposals")
    .option(...tokenOpt)
    .action(async (o: { doc?: string; token?: string }) => {
      const { proposals } = await (
        await docsClient(ctx, o.token)
      ).proposals({ doc: o.doc });
      for (const p of proposals)
        ctx.log(
          `${p.rev}\t${p.state}\t${p.doc}\t${p.author}\tgate ${p.gate ?? '-'}\t${p.createdAt}`
        );
    });

  for (const [name, status, what] of [
    [
      'reopen',
      'draft',
      'Reopen an accepted doc as a draft, withdrawing open proposals',
    ],
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
    .command('promote <ref>')
    .description('Copy a personal doc into a new team draft (its owner only)')
    .option(...tokenOpt)
    .action(async (ref: string, o: { token?: string }) => {
      const r = await (await docsClient(ctx, o.token)).promote(ref);
      ctx.log(`promoted to ${r.handle}`);
    });

  docs
    .command('publish <ref>')
    .description(
      'Write a reviewed or accepted team doc into the repo through an elevated task'
    )
    .option('--path <path>', 'repo-relative .md path (default: the last one)')
    .option('--no-dispatch', 'create the task without starting its run')
    .option(...tokenOpt)
    .action(
      async (
        ref: string,
        o: { path?: string; dispatch: boolean; token?: string }
      ) => {
        const api = await docsClient(ctx, o.token);
        let path = o.path;
        if (path === undefined) {
          const { doc } = await api.get(ref);
          path = doc.lastPublishPath ?? doc.published?.path;
        }
        if (path === undefined)
          throw new Error(`${ref} has no earlier publish path; pass --path`);
        const r = await api.publish(ref, {
          path,
          ...(o.dispatch ? {} : { dispatch: false }),
        });
        const started =
          r.run !== null
            ? `, run ${r.run}`
            : r.dispatchError !== null
              ? `; dispatch failed: ${r.dispatchError}`
              : ' (not dispatched)';
        ctx.log(`publishing ${ref} to ${path}: task ${r.task}${started}`);
      }
    );

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
        checkImportReport(report);
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
