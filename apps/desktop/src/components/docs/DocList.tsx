import type { DocSummary } from '@dispatch/client';
import {
  Button,
  Chip,
  EmptyState,
  Notice,
  Register,
  RegisterCell,
  RegisterRow,
  SegmentedControl,
  SkeletonRows,
  ViewToolbar,
} from '@dispatch/ui';
import { Check } from 'lucide-react';
import type { KeyboardEvent } from 'react';

import type { DocFilter } from '../../lib/docs';
import { docBadges, docBadgeTone } from '../../lib/docs';
import { resolveListKeyCommand } from '../../lib/keyboard';
import styles from './DocList.module.css';

const SCOPES: { id: DocFilter['scope']; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'team', label: 'Team' },
  { id: 'personal', label: 'Personal' },
];

// A pressed filter toggle leads with a check, so on reads as a shape and
// not only as the pressed fill (about 1.2:1 on the toolbar).
const PRESSED_MARK = <Check size={14} strokeWidth={1.8} />;

// One template for every row: the title takes the room, then the badges and
// the slug at the right edge.
const COLUMNS = 'minmax(0, 1fr) minmax(0, 220px) minmax(0, 160px)';

interface DocListProps {
  docs: readonly DocSummary[];
  filter: DocFilter;
  onFilter: (next: DocFilter) => void;
  /** The row marked as picked: the doc last opened. */
  selected: string | null;
  onSelect: (id: string) => void;
  error: Error | null;
  /** The list has not arrived yet. */
  loading?: boolean;
  /** Starts a new doc; the empty state offers it when given. */
  onNew?: () => void;
}

// Whether the filter is narrowing the list, so an empty result means "nothing
// matches" rather than "no docs yet".
function isNarrowed(f: DocFilter): boolean {
  return (
    f.query.trim() !== '' ||
    f.scope !== 'all' ||
    f.status !== 'active' ||
    f.unreviewedOnly
  );
}

// The All docs page: a toolbar (search, the scope, the Archived and
// Unreviewed toggles) over one register row per doc, named by its title,
// with its badges and its slug.
export function DocList({
  docs,
  filter,
  onFilter,
  selected,
  onSelect,
  error,
  loading = false,
  onNew,
}: DocListProps) {
  // j/k (and the arrows) open the doc after or before the focused row, or,
  // from the list's own tab stop, after the one last opened (the first doc
  // when none was), as in the other lists.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const command = resolveListKeyCommand(event, { isTyping: false });
    if (command !== 'list-down' && command !== 'list-up') return;
    event.preventDefault();
    if (docs.length === 0) return;
    const row =
      event.target instanceof HTMLElement
        ? event.target.closest<HTMLElement>('[data-doc]')
        : null;
    const from = row?.dataset.doc ?? selected;
    const at = docs.findIndex((d) => d.id === from);
    const next =
      command === 'list-down'
        ? Math.min(at + 1, docs.length - 1)
        : Math.max(at === -1 ? 0 : at - 1, 0);
    onSelect(docs[next].id);
  };
  const narrowed = isNarrowed(filter);
  return (
    <div className={styles.root}>
      <ViewToolbar
        label="Docs options"
        search={{
          value: filter.query,
          onChange: (query) => onFilter({ ...filter, query }),
          placeholder: 'Search docs',
          label: 'Search docs',
        }}
        controls={
          <>
            <SegmentedControl
              label="Scope"
              size="sm"
              options={SCOPES}
              value={filter.scope}
              onChange={(id) => {
                const scope = SCOPES.find((s) => s.id === id);
                if (scope !== undefined)
                  onFilter({ ...filter, scope: scope.id });
              }}
            />
            <Button
              variant="quiet"
              size="sm"
              aria-pressed={filter.status === 'archived'}
              icon={filter.status === 'archived' ? PRESSED_MARK : undefined}
              onClick={() =>
                onFilter({
                  ...filter,
                  status: filter.status === 'archived' ? 'active' : 'archived',
                })
              }
            >
              Archived
            </Button>
            <Button
              variant="quiet"
              size="sm"
              aria-pressed={filter.unreviewedOnly}
              icon={filter.unreviewedOnly ? PRESSED_MARK : undefined}
              onClick={() =>
                onFilter({ ...filter, unreviewedOnly: !filter.unreviewedOnly })
              }
            >
              Unreviewed
            </Button>
          </>
        }
      />
      {/* One tab stop for the whole list, as before the restyle: j/k typed
          here open a doc without first tabbing onto a row. */}
      <section
        aria-label="All docs"
        tabIndex={0}
        className={styles.scroller}
        onKeyDown={onKeyDown}
      >
        {error !== null && (
          <Notice tone="danger" role="alert">
            {error.message}
          </Notice>
        )}
        {loading && docs.length === 0 && error === null && (
          <SkeletonRows rows={4} label="Loading docs…" />
        )}
        {!loading && docs.length === 0 && error === null && (
          <EmptyState
            label={narrowed ? 'No docs match' : 'No docs yet'}
            action={
              !narrowed && onNew !== undefined ? (
                <Button size="sm" onClick={onNew}>
                  New doc
                </Button>
              ) : undefined
            }
          >
            {narrowed
              ? 'Try another search, or clear the filters.'
              : 'Specs and plans your agents save land here, linked to their tasks.'}
          </EmptyState>
        )}
        {docs.length > 0 && (
          <Register label="Docs" columns={COLUMNS} stackWithin={600}>
            {docs.map((d) => (
              <RegisterRow
                key={d.id}
                data-doc={d.id}
                rowLabel={d.title}
                selected={selected === d.id}
                onActivate={() => onSelect(d.id)}
              >
                <RegisterCell variant="name">{d.title}</RegisterCell>
                <RegisterCell>
                  <span className={styles.badges}>
                    {docBadges(d).map((b) => (
                      <Chip key={b} tone={docBadgeTone(b)}>
                        {b}
                      </Chip>
                    ))}
                  </span>
                </RegisterCell>
                <RegisterCell align="end">
                  <span className={styles.slug}>{d.handle}</span>
                </RegisterCell>
              </RegisterRow>
            ))}
          </Register>
        )}
      </section>
    </div>
  );
}
