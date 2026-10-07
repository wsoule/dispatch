import { type ReactNode, useState } from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { useDocList } from '../../hooks/useDocs';
import { GroupHeader } from '@/ui/ai/group-header';
import { ListRow } from '@/ui/ai/list-row';
import { Badge } from '@/ui/badge';
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
      {open && (
        <div role="list" className="flex flex-col pb-1">
          {children}
        </div>
      )}
    </section>
  );
}

/** The groups today's views lose: notes to convert, PRs with no task, docs with no task. */
export function TasksExtraGroups({
  data,
  onOpenPr,
  onOpenDoc,
  onOpenAllDocs,
  onOpenNotes,
}: {
  data: DispatchProjectData;
  onOpenPr: (number: number) => void;
  onOpenDoc: (docId: string) => void;
  onOpenAllDocs: () => void;
  /** The full Notes page: capture, triage and planning from notes. */
  onOpenNotes: () => void;
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
      <Section
        name="Notes"
        count={notes.length}
        testId="tasks-group-notes"
        extra={
          <Button variant="link" size="xs" onClick={onOpenNotes}>
            All notes →
          </Button>
        }
      >
        {notes.map((note) => (
          <ListRow
            key={note.id}
            role="listitem"
            title={note.text}
            trailing={
              <>
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
              </>
            }
          />
        ))}
      </Section>
      <Section name="Pull requests" count={prs.length} testId="tasks-group-prs">
        {prs.map((pr) => (
          <ListRow
            key={pr.number}
            role="listitem"
            onClick={() => onOpenPr(pr.number)}
            id={`#${pr.number}`}
            title={pr.title}
            date={pr.author}
          />
        ))}
      </Section>
      {docsClient !== null && (
        <Section
          name="▤ Docs"
          count={teamDocs.length}
          testId="tasks-group-docs"
          extra={
            <>
              {unreviewed > 0 && (
                <Badge variant="outline">{unreviewed} unreviewed</Badge>
              )}
              <Button variant="link" size="xs" onClick={onOpenAllDocs}>
                All docs →
              </Button>
            </>
          }
        >
          {teamDocs.map((doc) => (
            <ListRow
              key={doc.id}
              role="listitem"
              onClick={() => onOpenDoc(doc.id)}
              title={doc.title}
              trailing={
                doc.unreviewed ? (
                  <Badge variant="outline">unreviewed</Badge>
                ) : undefined
              }
            />
          ))}
          {personalDocs.length > 0 && (
            <div
              role="listitem"
              className="text-muted-foreground px-3 py-1 text-[12px]"
            >
              Personal · {personalDocs.length} · only you
            </div>
          )}
        </Section>
      )}
    </div>
  );
}
