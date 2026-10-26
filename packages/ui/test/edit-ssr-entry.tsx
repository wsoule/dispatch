import { renderToString } from 'react-dom/server';

import {
  AssigneePicker,
  DateField,
  EstimatePicker,
  InlineTextField,
  LabelPicker,
  MilestonePicker,
  PriorityPicker,
  ProjectPicker,
  StatePicker,
  TaskDetail,
  TaskRelationPicker,
  TextAreaEditor,
} from '../src/index';

// Run by edit-ssr.test.tsx in a child `bun run` with no happy-dom preload:
// no window or document, like a Next server render. Every edit control
// must render (closed) without touching either.

const noop = () => undefined;

const controls = (
  <>
    <StatePicker
      states={[
        { id: 's1', name: 'Todo', kind: 'unstarted' },
        { id: 's2', name: 'In Progress', kind: 'started' },
      ]}
      value="s2"
      onChange={noop}
    />
    <AssigneePicker
      people={[{ id: 'u1', name: 'Ana Moreno' }]}
      value={null}
      onChange={noop}
    />
    <PriorityPicker value={2} onChange={noop} />
    <LabelPicker
      labelOptions={[
        { id: 'l1', name: 'Bug', color: '#eb5757' },
        { id: 'l2', name: 'Evil', color: 'red;background:url(x)' },
      ]}
      value={['l1', 'l2']}
      onChange={noop}
    />
    <ProjectPicker
      projects={[{ id: 'p1', name: 'Beacon search' }]}
      value="p1"
      onChange={noop}
    />
    <MilestonePicker milestones={[]} value={null} onChange={noop} />
    <EstimatePicker
      estimates={[{ value: 3, label: '3 points' }]}
      value={3}
      onChange={noop}
    />
    <TaskRelationPicker
      label="Add blocked by"
      search={() => Promise.resolve([])}
      onSelect={noop}
    />
    <DateField label="Due date" value="2026-10-23" onChange={noop} />
    <TextAreaEditor label="Description" value="Line <b>one</b>" onSave={noop} />
    <TextAreaEditor mode="compose" label="Comment" onSave={noop} />
  </>
);

const detail = (
  <TaskDetail
    taskKey="ENG-24"
    title="Search analytics events"
    titleControl={
      <InlineTextField
        label="Title"
        value="Search analytics events"
        onSave={noop}
      />
    }
    status={{ kind: 'started', label: 'In Progress' }}
    properties={[{ label: 'Assignee', value: 'Ana Moreno' }]}
    relations={{ blockedBy: [], blocks: [] }}
    sectionMeta={{
      blockedBy: (
        <TaskRelationPicker
          label="Add blocked by"
          search={() => Promise.resolve([])}
          onSelect={noop}
        />
      ),
    }}
    comments={{
      items: [
        { id: 'c1', author: 'Ana Moreno', at: 'Oct 19', body: '<i>hi</i>' },
      ],
      composer: <TextAreaEditor mode="compose" label="Comment" onSave={noop} />,
    }}
    layout="page"
  />
);

console.log(
  JSON.stringify({
    hasWindow: typeof window !== 'undefined',
    hasDocument: typeof document !== 'undefined',
    controls: renderToString(controls),
    detail: renderToString(detail),
  })
);
