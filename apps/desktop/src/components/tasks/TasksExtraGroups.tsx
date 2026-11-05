import {
  Button,
  Chip,
  Register,
  RegisterCell,
  RegisterRow,
  SectionHeader,
} from '@dispatch/ui';
import { FileText } from 'lucide-react';
import { type ReactNode, useState } from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { useDocList } from '../../hooks/useDocs';
import styles from './TasksExtraGroups.module.css';

const UNLINKED_TEAM_DOCS = { unlinked: true, scope: 'team' } as const;
const PERSONAL_DOCS = { scope: 'personal' } as const;

/* The registers' grids: a note and its two buttons; a PR's number, title
   and author; a doc's title and its "unreviewed" chip. */
const NOTE_COLUMNS = 'minmax(0, 1fr) auto';
const PR_COLUMNS = '56px minmax(0, 1fr) auto';
const DOC_COLUMNS = 'minmax(0, 1fr) auto';

// One folding section under the task groups: a group header with the fold
// chevron, the count and the host's actions, then (open) its rows.
function Section({
  name,
  icon,
  count,
  testId,
  extra,
  children,
}: {
  name: string;
  icon?: ReactNode;
  count: number;
  testId: string;
  extra?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section data-testid={testId} aria-label={name} className={styles.section}>
      <SectionHeader
        name={name}
        icon={icon}
        count={count}
        collapsed={!open}
        onToggle={() => setOpen(!open)}
        actions={extra}
      />
      {open && <div className={styles.rows}>{children}</div>}
    </section>
  );
}

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
    <div data-testid="tasks-extra-groups" className={styles.root}>
      <Section name="Notes" count={notes.length} testId="tasks-group-notes">
        {notes.length > 0 && (
          <Register label="Notes" columns={NOTE_COLUMNS} stackWithin={480}>
            {notes.map((note) => (
              <RegisterRow key={note.id}>
                <RegisterCell>
                  <span className={styles.line} title={note.text}>
                    {note.text}
                  </span>
                </RegisterCell>
                <RegisterCell align="end">
                  <span className={styles.actions}>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void data.handleConvertInbox([note.id])}
                    >
                      Convert
                    </Button>
                    <Button
                      size="sm"
                      variant="quiet"
                      onClick={() => void data.handleDismissInbox([note.id])}
                    >
                      Dismiss
                    </Button>
                  </span>
                </RegisterCell>
              </RegisterRow>
            ))}
          </Register>
        )}
      </Section>
      <Section name="Pull requests" count={prs.length} testId="tasks-group-prs">
        {prs.length > 0 && (
          <Register
            label="Pull requests"
            columns={PR_COLUMNS}
            stackWithin={480}
          >
            {prs.map((pr) => (
              <RegisterRow
                key={pr.number}
                onActivate={() => onOpenPr(pr.number)}
                rowLabel={`#${pr.number} ${pr.title}`}
              >
                <RegisterCell variant="mono">
                  <span className="mono">#{pr.number}</span>
                </RegisterCell>
                <RegisterCell variant="name">
                  <span className={styles.line}>{pr.title}</span>
                </RegisterCell>
                <RegisterCell variant="mono" align="end">
                  {pr.author}
                </RegisterCell>
              </RegisterRow>
            ))}
          </Register>
        )}
      </Section>
      {docsClient !== null && (
        <Section
          name="Docs"
          icon={<FileText size={14} strokeWidth={1.8} aria-hidden="true" />}
          count={teamDocs.length}
          testId="tasks-group-docs"
          extra={
            <>
              {unreviewed > 0 && (
                <Chip tone="warning">{unreviewed} unreviewed</Chip>
              )}
              <Button
                variant="quiet"
                size="sm"
                className={styles.link}
                onClick={onOpenAllDocs}
              >
                All docs →
              </Button>
            </>
          }
        >
          {teamDocs.length > 0 && (
            <Register label="Docs" columns={DOC_COLUMNS} stackWithin={480}>
              {teamDocs.map((doc) => (
                <RegisterRow
                  key={doc.id}
                  onActivate={() => onOpenDoc(doc.id)}
                  rowLabel={
                    doc.unreviewed ? `${doc.title}, unreviewed` : doc.title
                  }
                >
                  <RegisterCell variant="name">
                    <span className={styles.line}>{doc.title}</span>
                  </RegisterCell>
                  <RegisterCell align="end">
                    {doc.unreviewed ? (
                      <Chip tone="warning">unreviewed</Chip>
                    ) : null}
                  </RegisterCell>
                </RegisterRow>
              ))}
            </Register>
          )}
          {personalDocs.length > 0 && (
            <p className={styles.personal}>
              Personal · {personalDocs.length} · only you
            </p>
          )}
        </Section>
      )}
    </div>
  );
}
