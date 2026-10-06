import { type ReactNode, useState } from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { useDocList } from '../../hooks/useDocs';
import { GroupHeader } from '@/ui/ai/group-header';
import { Button } from '@/ui/button';

const UNLINKED_TEAM_DOCS = { unlinked: true, scope: 'team' } as const;
const PERSONAL_DOCS = { scope: 'personal' } as const;

// One folding section under the task groups.
function Section({
  name,
  count,
  testId,
  extra,
  children,
}: {
  name: ReactNode;
  count: number;
  testId: string;
  extra?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section
      data-testid={testId}
      aria-label={typeof name === 'string' ? name : undefined}
    >
      <GroupHeader
        name={name}
        count={count}
        collapsed={!open}
        onToggle={() => setOpen(!open)}
        actions={extra}
      />
      {open && <ul className="flex flex-col pb-1">{children}</ul>}
    </section>
  );
}

const ROW = 'flex min-h-9 items-center gap-2 px-3 text-[13px]';

/** The groups today's views lose: notes to convert, PRs with no task, docs with no task. */
export function TasksExtraGroups({
  data,
  onOpenPr,
  onOpenDoc,
  onOpenAllDocs,
}: {
  data: DispatchProjectData;
  onOpenPr: (number: number) => void;
  onOpenDoc: (docId: string) => void;
  onOpenAllDocs: () => void;
}) {
  const notes = data.inbox.filter((item) => !item.done);
  const claimed = new Set(data.runs.flatMap((r) => (r.prUrl ? [r.prUrl] : [])));
  const prs = (data.repoPrs ?? []).filter(
    (pr) => pr.state === 'OPEN' && !claimed.has(pr.url)
  );
  const docsClient = data.messageAccess.canMessage ? data.client : null;
  const teamDocs = useDocList(docsClient, data.port, UNLINKED_TEAM_DOCS).docs;
  const personalDocs = useDocList(docsClient, data.port, PERSONAL_DOCS).docs;
  const unreviewed = teamDocs.filter((d) => d.unreviewed).length;

  return (
    <div data-testid="tasks-extra-groups" className="pt-2">
      <Section name="Notes" count={notes.length} testId="tasks-group-notes">
        {notes.map((note) => (
          <li key={note.id} className={ROW}>
            <span className="min-w-0 flex-1 truncate">{note.text}</span>
            <Button
              size="xs"
              variant="outline"
              onClick={() => void data.handleConvertInbox([note.id])}
            >
              Convert
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => void data.handleDismissInbox([note.id])}
            >
              Dismiss
            </Button>
          </li>
        ))}
      </Section>
      <Section name="Pull requests" count={prs.length} testId="tasks-group-prs">
        {prs.map((pr) => (
          <li key={pr.number} className={ROW}>
            <button
              type="button"
              onClick={() => onOpenPr(pr.number)}
              className="min-w-0 flex-1 truncate text-left hover:underline"
            >
              <span className="text-muted-foreground font-mono text-[12px]">
                #{pr.number}
              </span>{' '}
              {pr.title}
            </button>
            <span className="text-muted-foreground text-[12px]">
              {pr.author}
            </span>
          </li>
        ))}
      </Section>
      {docsClient !== null && (
        <Section
          name="▤ Docs"
          count={teamDocs.length}
          testId="tasks-group-docs"
          extra={
            <span className="flex items-center gap-2 text-[12px]">
              {unreviewed > 0 && (
                <span className="text-muted-foreground rounded-chip border border-dashed border-(--text-ghost) px-1.5">
                  {unreviewed} unreviewed
                </span>
              )}
              <button
                type="button"
                onClick={onOpenAllDocs}
                className="text-(--accent) hover:underline"
              >
                All docs →
              </button>
            </span>
          }
        >
          {teamDocs.map((doc) => (
            <li key={doc.id} className={ROW}>
              <button
                type="button"
                onClick={() => onOpenDoc(doc.id)}
                className="min-w-0 flex-1 truncate text-left hover:underline"
              >
                {doc.title}
              </button>
              {doc.unreviewed && (
                <span className="text-muted-foreground rounded-chip border border-dashed border-(--text-ghost) px-1.5 text-[11px]">
                  unreviewed
                </span>
              )}
            </li>
          ))}
          {personalDocs.length > 0 && (
            <li className="text-muted-foreground px-3 py-1 text-[12px]">
              Personal · {personalDocs.length} · only you
            </li>
          )}
        </Section>
      )}
    </div>
  );
}
