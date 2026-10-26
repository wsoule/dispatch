import { renderToString } from 'react-dom/server';

import {
  BulkBar,
  FilterChips,
  PickerPopover,
  TaskDetail,
  type TaskDetailProps,
  TaskGroupTable,
  TaskSlideOver,
  ViewToolbar,
} from '../src/index';

// Run by task-ssr.test.tsx in a child `bun run`, which has no happy-dom
// preload: there is no window or document here, exactly like a Next server
// render. TaskDetail and TaskSlideOver must render without touching either.

const props: TaskDetailProps = {
  taskKey: 'ENG-24',
  title: 'Search analytics events',
  href: 'https://linear.app/northwind/issue/ENG-24',
  breadcrumb: [
    { label: 'Beacon search', href: '/timeline?project=beacon' },
    { label: 'ENG-24' },
  ],
  status: { kind: 'unstarted', label: 'Todo' },
  alerts: [{ label: 'Stalled', message: 'In Todo for 9 days.' }],
  properties: [{ label: 'Assignee', value: 'Ana Moreno' }],
  description: {
    text: `<script>alert(1)</script>\n${Array.from(
      { length: 20 },
      (_, i) => `Line ${i + 1}`
    ).join('\n')}`,
    sourceLabel: 'From Linear',
  },
  relations: {
    blockedBy: [
      {
        id: 'eng-23',
        taskKey: 'ENG-23',
        title: 'Typo tolerance',
        href: 'https://linear.app/northwind/issue/ENG-23',
        state: { kind: 'started', label: 'In Progress' },
        assignee: 'Dev Patel',
      },
    ],
    blocks: [],
  },
  activity: [{ id: 'a', at: 'Oct 21', label: 'Flagged as stalled' }],
};

// The issue list's parts: the table with selection, drag and every slot,
// the toolbar, the chips and the bulk bar (with a confirmation).
const issueList = (
  <>
    <ViewToolbar
      busy
      search={{
        value: 'billing',
        onChange: () => undefined,
        placeholder: 'Search issues',
        label: 'Search issues',
      }}
      controls={
        <PickerPopover
          label="Sort"
          options={[{ value: 'weight', label: 'Weight' }]}
          value="weight"
          searchable={false}
          appearance="quiet"
          onChange={() => undefined}
        />
      }
    />
    <FilterChips
      chips={[
        {
          id: 'state',
          field: 'Status',
          summary: 'open',
          onRemove: () => undefined,
          removeLabel: 'Remove status filter',
        },
      ]}
      onClearAll={() => undefined}
      clearDisabled
    />
    <TaskGroupTable
      label="Issues"
      columns={['milestone', 'assignee', 'state']}
      selection={{ selected: new Set(['eng-12']), onChange: () => undefined }}
      drag={{
        canDrop: () => true,
        onDrop: () => undefined,
        label: (n) => `${n} issues`,
      }}
      rowActions={() => <button type="button">…</button>}
      groupActions={() => <button type="button">Group menu</button>}
      renderCell={(column) =>
        column === 'state' ? (
          <PickerPopover
            label="Status"
            options={[{ value: 's', label: 'In Progress' }]}
            value="s"
            appearance="cell"
            onChange={() => undefined}
          />
        ) : undefined
      }
      sections={[
        {
          id: 'only',
          groups: [
            {
              id: 'm1',
              eyebrow: 'Atlas',
              title: 'Dual-write',
              count: 212,
              tags: ['Next'],
              missingLabel: 'Missing: done means…',
              footer: {
                text: 'Showing 1 of 212',
                actions: [{ label: 'Show more', onActivate: () => undefined }],
              },
              rows: [
                {
                  id: 'eng-12',
                  key: 'ENG-12',
                  title: 'Backfill the ledger',
                  state: 'In Progress',
                  stateKind: 'started',
                  priority: 2,
                  priorityLabel: 'High',
                  assignee: null,
                  assigneeTone: 'warning',
                  milestone: 'Dual-write',
                  milestoneProject: 'Atlas',
                  pending: true,
                  note: { text: 'Moving to Dual-write…' },
                },
              ],
            },
          ],
        },
      ]}
    />
    <BulkBar
      count={24}
      onClear={() => undefined}
      confirm={{
        message: 'Move 24 issues to Atlas › Dual-write?',
        confirmLabel: 'Move 24 issues',
        onConfirm: () => undefined,
        onCancel: () => undefined,
      }}
    >
      <button type="button">Move to milestone</button>
    </BulkBar>
  </>
);

console.log(
  JSON.stringify({
    hasWindow: typeof window !== 'undefined',
    hasDocument: typeof document !== 'undefined',
    page: renderToString(<TaskDetail {...props} layout="page" />),
    drawer: renderToString(
      <TaskSlideOver {...props} open onClose={() => undefined} />
    ),
    issueList: renderToString(issueList),
  })
);
