import { renderToString } from 'react-dom/server';

import {
  BulkBar,
  Checkbox,
  Checklist,
  Chip,
  ChipButton,
  CodeBlock,
  CopyValue,
  Disclosure,
  FilterChips,
  ListItem,
  NavTabs,
  Notice,
  Panel,
  PanelRow,
  PickerPopover,
  ProgressPie,
  Register,
  RegisterCell,
  RegisterRow,
  SearchField,
  SectionHeader,
  SegmentedControl,
  StatePicker,
  Switch,
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

// A toolbar of controls only (Runs, Usage): no search field, the host's
// control and an end action.
const controlsToolbar = (
  <ViewToolbar
    label="Run filters"
    controls={<button type="button">All runs</button>}
    end={<button type="button">Show archived (2)</button>}
  />
);

// A list over the windowing threshold: the server draws the first rows of
// the first groups and an estimated gap for the rest, reading no layout.
const windowedList = (
  <TaskGroupTable
    label="Issues"
    sections={[
      {
        id: 'all',
        groups: [0, 1, 2].map((g) => ({
          id: `g${g}`,
          title: `Group ${g}`,
          rows: Array.from({ length: 100 }, (_, i) => ({
            id: `r${g}-${i}`,
            key: `ENG-${g}${i}`,
            title: `Row ${g}-${i}`,
            href: `/issues/r${g}-${i}`,
            state: 'Todo',
            stateKind: 'unstarted' as const,
            priority: 3 as const,
            priorityLabel: 'Medium',
          })),
        })),
      },
    ]}
  />
);

// Folds: closed (the panel there, hidden and empty), open from the first
// render, kept mounted while closed, and a host's own trigger.
const disclosures = (
  <>
    <Disclosure id="fold-closed" summary="Details">
      <pre>never on the server</pre>
    </Disclosure>
    <Disclosure
      id="fold-open"
      defaultOpen
      variant="bar"
      summary={({ open }) => (open ? 'Hide steps' : 'Show steps')}
      data-testid="setup-fold"
    >
      <p>Install the CLI</p>
    </Disclosure>
    <Disclosure id="fold-kept" keepMounted summary="Reason">
      <p>Kept while closed</p>
    </Disclosure>
    <Disclosure
      id="fold-chip"
      trigger={({ props }) => (
        <button {...props} className="chip">
          +3 more
        </button>
      )}
    >
      <p>Three more</p>
    </Disclosure>
  </>
);

// The primitives the Settings page builds on: the search field (with
// text, so its clear button renders), the copy value (no clipboard read
// before a press), the grouped sub-nav, the chip button both ways, and
// the data-* passthrough of Chip, Switch, Checkbox, Notice and Register.
const primitives = (
  <>
    <SearchField
      value="linear"
      onChange={() => undefined}
      label="Search settings"
      data-testid="settings-search"
    />
    <CopyValue value="dsp_tok_123" label="token" data-testid="issued-token" />
    <NavTabs
      label="Settings"
      groups={[
        {
          label: 'Project',
          items: [
            { id: 'general', label: 'General', href: '#/g', current: true },
          ],
        },
      ]}
    />
    <ChipButton selected>Blocked</ChipButton>
    <ChipButton href="/runs">Runs</ChipButton>
    <Chip tone="danger" filled data-testid="failed-chip">
      Failed
    </Chip>
    <Switch label="Live" hideLabel data-testid="live-switch" />
    <Checkbox label="Viewed" data-testid="viewed-box" />
    <Notice role="note" tone="default" data-testid="read-only">
      Read only.
    </Notice>
    <SegmentedControl
      label="Agent state"
      options={[
        { id: 'all', label: 'All', count: 5 },
        { id: 'live', label: 'Live', count: 2 },
      ]}
      value="all"
    />
    <Register columns="1fr" label="Spend" data-testid="spend" stackWithin={600}>
      <RegisterRow
        rowLabel="Filter by Atlas"
        onActivate={() => undefined}
        pressed
        data-testid="spend-row"
      >
        <RegisterCell data-slot="cost">$4</RegisterCell>
        <RegisterCell span="row" data-slot="spend-note">
          <p>Over budget</p>
        </RegisterCell>
      </RegisterRow>
    </Register>
  </>
);

// The board's building blocks (B5): a lane header with its fold, tone,
// count, actions and host hooks; a progress pie, named and decorative;
// label chips with a colour square and with a hue dot; a card's
// glyph-only property picker.
const board = (
  <>
    <SectionHeader
      name="In progress"
      count={4}
      tone="info"
      collapsed
      onToggle={() => undefined}
      onAdd={() => undefined}
      addLabel="New task in In progress"
      actions={<span data-testid="lane-menu" />}
      sticky
      rule
      data-slot="group-header"
    />
    <ProgressPie done={3} total={8} label="3 of 8 done" tone="success" />
    <ProgressPie done={0} total={0} size={14} label="" />
    <Chip mark={{ kind: 'swatch', color: '#e5484d' }}>Bug</Chip>
    <Chip hue="violet">Frontend</Chip>
    <StatePicker
      states={[{ id: 's-doing', name: 'In Progress', kind: 'started' }]}
      value="s-doing"
      appearance="mark"
      onChange={() => undefined}
    />
  </>
);

// A host's own lists (B7): list items (clickable, unread and nested; an
// option; a button row with a trailing control beside it), a panel with
// its heading row, tone and rows (urgent, clickable), a removable chip.
const lists = (
  <>
    <ListItem
      title="Ana replied"
      crumb="Overseer"
      meta="3 replies"
      date="Sep 13"
      unread
      indent={1}
      role="listitem"
      onClick={() => undefined}
      data-testid="overseer-notification-row"
    />
    {/* ListItem sets aria-selected from `selected` under role option. */}
    {/* oxlint-disable-next-line jsx-a11y/role-has-required-aria-props */}
    <ListItem title="Thread 7" role="option" selected domId="thread-7" />
    <ListItem
      as="button"
      title="Docked"
      data-testid="overseer-docked"
      trailing={<span data-testid="docked-count">2</span>}
    />
    <Panel
      heading="Coming in"
      count={2}
      tone="warning"
      floating
      flush
      actions={<span data-testid="panel-actions" />}
      data-testid="overseer-inflow"
    >
      <PanelRow urgent urgentLabel="Failed" onActivate={() => undefined}>
        Build the docs
      </PanelRow>
      <PanelRow urgent>Merge the fix</PanelRow>
    </Panel>
    <Chip onRemove={() => undefined}>boot.rs</Chip>
  </>
);

// Code blocks (B8): a fence with a header (filename, language, Copy), a
// blank line and a cap; a wrapped one with no header at all.
const codeBlocks = (
  <>
    <CodeBlock
      code={'const a = 1;\n\nconst b = 2;\n'}
      filename="src/app.ts"
      language="TypeScript"
      maxHeight={240}
      data-testid="fence"
    />
    <CodeBlock code="echo done" copy={false} wrap />
  </>
);

// A highlighted fence with a host action, and one whose body a diagram
// stands in for (the desktop's Markdown fences, merged from main v0.51.0).
const codeBlocksHosted = (
  <>
    <CodeBlock
      code={'let a\nb'}
      copy={false}
      tokens={[
        [
          { content: 'let', vars: { '--shiki-light': 'red' } },
          { content: ' a' },
        ],
        [{ content: 'b' }],
      ]}
      actions={
        <button type="button" aria-pressed="false">
          Wrap lines
        </button>
      }
    />
    <CodeBlock code="graph TD" language="mermaid" copy={false}>
      <div data-testid="diagram" />
    </CodeBlock>
  </>
);

// A checklist a person ticks (B9, ReviewMode's criteria): Checkbox rows, one
// met (checked) and one not, the second reported by its index.
const checkboxChecklist = (
  <Checklist
    label="Review checklist"
    items={[
      { id: 'hashed', label: 'Events are hashed', met: true },
      { label: 'Sampling is configurable', met: false },
    ]}
    onToggle={() => undefined}
  />
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
    controlsToolbar: renderToString(controlsToolbar),
    windowedList: renderToString(windowedList),
    disclosures: renderToString(disclosures),
    primitives: renderToString(primitives),
    board: renderToString(board),
    lists: renderToString(lists),
    codeBlocks: renderToString(codeBlocks),
    codeBlocksHosted: renderToString(codeBlocksHosted),
    checkboxChecklist: renderToString(checkboxChecklist),
  })
);
