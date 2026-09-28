import type { ApiClient, DocLinking } from '@dispatch/client';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import {
  docsKey,
  useDocList,
  useDocSearch,
  useDocsLinking,
} from '../../../hooks/useDocs';
import { describeError } from '../../../lib/actionFeedback';
import { docBadges, filterDocs } from '../../../lib/docs';
import { MainSection } from '../detail/MainSection';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';

// How many docs the Link doc picker lists for its query.
const PICKER_ROWS = 8;
// Search hits the picker asks for: several may name one doc's sections.
const PICKER_HITS = 20;
// How long typing must pause before the picker searches the daemon.
const PICKER_SEARCH_MS = 150;

// A task's own links by role; links it inherits from its epics come last.
export function groupTaskDocs(linking: readonly DocLinking[]): {
  spec: DocLinking | null;
  plans: DocLinking[];
  context: DocLinking[];
  fromParents: DocLinking[];
} {
  const own = linking.filter((l) => !l.fromParent);
  return {
    spec: own.find((l) => l.rel === 'spec') ?? null,
    plans: own.filter((l) => l.rel === 'plan'),
    context: own.filter((l) => l.rel === 'context'),
    fromParents: linking.filter((l) => l.fromParent),
  };
}

interface TaskDocsBlockProps {
  client: ApiClient;
  port: number | undefined;
  taskId: string;
  /** Whether this caller may create and link docs. */
  canLink: boolean;
  onOpenDoc: (docId: string) => void;
}

// The docs a task links, spec first, with New spec and Link doc when the caller may.
export function TaskDocsBlock({
  client,
  port,
  taskId,
  canLink,
  onOpenDoc,
}: TaskDocsBlockProps) {
  const queryClient = useQueryClient();
  const target = `task:${taskId}`;
  const {
    docs: linking,
    loading,
    error: linkingError,
  } = useDocsLinking(client, port, target);
  const g = groupTaskDocs(linking);
  // New spec and Link doc wait for the task's links, so a spec still loading
  // or a failed request never reads as a task with no docs.
  const mayAct = canLink && !loading && linkingError === null;
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Runs one create or link, then refreshes every docs query; a failure shows inline.
  const act = (work: () => Promise<void>): void => {
    setError(null);
    void work().then(
      () => queryClient.invalidateQueries({ queryKey: docsKey(port) }),
      (err: unknown) => setError(describeError(err))
    );
  };
  const newSpec = () =>
    act(async () => {
      const title = `Spec for ${taskId}`;
      const made = await client.createDoc({
        title,
        body: `# ${title}\n`,
        links: [{ target, rel: 'spec' }],
      });
      onOpenDoc(made.doc.id);
    });
  const linkContext = (docId: string) =>
    act(async () => {
      await client.linkDoc(docId, { target, rel: 'context' });
      setPicking(false);
    });

  if (linking.length === 0 && !canLink) return null;
  const row = (l: DocLinking, label: string) => (
    <li key={`${label}-${l.doc.id}`}>
      <button
        type="button"
        className="flex h-7 w-full min-w-0 items-center gap-2 text-left text-[13px] hover:underline"
        onClick={() => onOpenDoc(l.doc.id)}
      >
        <span className="text-muted-foreground shrink-0 text-[12px]">
          {label}
        </span>
        <span className="truncate">{l.doc.title}</span>
        {docBadges(l.doc)
          .filter((b) => b === 'unreviewed' || b === 'accepted')
          .map((b) => (
            <span
              key={b}
              className="shrink-0 rounded bg-[var(--color-muted)] px-1 text-[10px]"
            >
              {b}
            </span>
          ))}
      </button>
    </li>
  );
  return (
    <MainSection
      title="Docs"
      trailing={
        mayAct ? (
          <>
            {g.spec === null && (
              <Button size="xs" variant="ghost" onClick={newSpec}>
                New spec
              </Button>
            )}
            <Button
              size="xs"
              variant="ghost"
              aria-expanded={picking}
              onClick={() => setPicking((p) => !p)}
            >
              Link doc
            </Button>
          </>
        ) : undefined
      }
    >
      {picking && (
        <DocPicker
          client={client}
          port={port}
          linked={
            new Set(linking.filter((l) => !l.fromParent).map((l) => l.doc.id))
          }
          onPick={linkContext}
        />
      )}
      {error !== null && (
        <p role="alert" className="text-destructive text-[12px]">
          {error}
        </p>
      )}
      {linkingError !== null && (
        <p className="text-muted-foreground text-[12px]">
          {describeError(linkingError)}
        </p>
      )}
      {linking.length > 0 && (
        <ul className="flex flex-col">
          {g.spec !== null && row(g.spec, 'spec')}
          {g.plans.map((l) => row(l, 'plan'))}
          {g.context.map((l) => row(l, 'context'))}
          {g.fromParents.map((l) => row(l, `from parent · ${l.rel}`))}
        </ul>
      )}
    </MainSection>
  );
}

// Finds an active doc the task does not link yet: listed docs by title or
// handle as typed, then the daemon's search hits, which cover every doc's text.
function DocPicker({
  client,
  port,
  linked,
  onPick,
}: {
  client: ApiClient;
  port: number | undefined;
  linked: ReadonlySet<string>;
  onPick: (docId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [searched, setSearched] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setSearched(query.trim()), PICKER_SEARCH_MS);
    return () => clearTimeout(timer);
  }, [query]);
  const { docs } = useDocList(client, port, { limit: 200 });
  const hits = useDocSearch(client, port, searched, PICKER_HITS);
  // Focused on mount rather than through `autoFocus`: the picker opens only on a click.
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    field.current?.focus();
  }, []);
  const listed = filterDocs(docs, {
    query,
    scope: 'all',
    status: 'active',
    unreviewedOnly: false,
  }).map((d) => ({ id: d.id, title: d.title }));
  const found =
    searched === query.trim()
      ? hits.map((h) => ({ id: h.doc, title: h.title }))
      : [];
  const seen = new Set(linked);
  const matches: { id: string; title: string }[] = [];
  for (const d of [...listed, ...found]) {
    if (matches.length === PICKER_ROWS) break;
    if (seen.has(d.id)) continue;
    seen.add(d.id);
    matches.push(d);
  }
  return (
    <div className="flex flex-col gap-1">
      <Input
        ref={field}
        aria-label="Find a doc"
        placeholder="Find a doc…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <ul className="flex flex-col">
        {matches.map((d) => (
          <li key={d.id}>
            <button
              type="button"
              className="flex h-7 w-full min-w-0 items-center text-left text-[13px] hover:underline"
              onClick={() => onPick(d.id)}
            >
              <span className="truncate">{d.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
