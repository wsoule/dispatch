import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  DeadlineList,
  TaskActivityList,
  TaskGroupTable,
  TaskPropertyValue,
  type TaskRowData,
} from '../src/index';

// Status colours on the lists and the task view (owner decision
// 2026-10-22, docs/architecture.md §8.2): due dates, the urgent label,
// deadline groups, property values and notes, the activity ledger, an
// unassigned relation and refused edit fields take the status hues
// through data-tone (--tone, --tone-ink) or a hue token, never the purple
// accent. CSS modules resolve to empty objects under Bun, so the DOM is
// checked through data-tone and the colours through the stylesheets.

afterEach(cleanup);

const srcDir = path.join(import.meta.dir, '..', 'src');

/** A stylesheet under src, comments removed and whitespace collapsed. */
function css(file: string): string {
  return readFileSync(path.join(srcDir, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ');
}

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(sheet: string, selector: string): string {
  const at = sheet.indexOf(`${selector} {`);
  expect([selector, at >= 0]).toEqual([selector, true]);
  const open = sheet.indexOf('{', at);
  return sheet.slice(open + 1, sheet.indexOf('}', open)).trim();
}

function row(id: string, extra: Partial<TaskRowData> = {}): TaskRowData {
  return {
    id,
    key: id.toUpperCase(),
    title: `Issue ${id}`,
    href: `/issues/${id}`,
    state: 'Todo',
    stateKind: 'unstarted',
    priority: 3,
    priorityLabel: 'Medium',
    due: 'Oct 23',
    ...extra,
  };
}

describe('TaskGroupTable', () => {
  const sheet = css('tasks/task-group-table.module.css');

  test('due dates take their tone; the urgent label is red', () => {
    expect(rule(sheet, '.toneText')).toBe('color: var(--tone-ink);');
    expect(rule(sheet, '.urgentText')).toBe('color: var(--red);');
    expect(sheet).not.toContain('.accentText');
  });

  test('a group and its rows carry their due tones', () => {
    const view = render(
      <TaskGroupTable
        sections={[
          {
            id: 'week',
            label: 'This week',
            groups: [
              {
                id: 'g',
                title: 'Cutover',
                status: 'at_risk',
                statusLabel: 'At risk',
                dueLabel: 'Oct 22',
                daysLeftLabel: 'tomorrow',
                dueTone: 'warning',
                progress: { done: 1, total: 4, tone: 'warning' },
                rows: [
                  row('a-1', { dueTone: 'warning' }),
                  row('a-2', { dueTone: 'danger', due: 'Oct 18' }),
                ],
              },
            ],
          },
        ]}
      />
    );
    const tones = [...view.container.querySelectorAll('[data-tone]')].map(
      (el) => el.getAttribute('data-tone')
    );
    // The group's date and progress, then each row's date.
    expect(tones).toEqual(['warning', 'warning', 'warning', 'danger']);
  });
});

describe('DeadlineList', () => {
  test('a group label takes its tone', () => {
    expect(rule(css('tasks/deadline-list.module.css'), '.toned')).toBe(
      'color: var(--tone-ink);'
    );
    const view = render(
      <DeadlineList
        groups={[
          { id: 'over', label: 'Overdue', tone: 'danger', items: [] },
          { id: 'today', label: 'Today', tone: 'warning', items: [] },
          { id: 'week', label: 'This week', items: [] },
        ]}
      />
    );
    const labels = ['Overdue', 'Today', 'This week'].map((label) =>
      within(view.container).getByText(label).getAttribute('data-tone')
    );
    expect(labels).toEqual(['danger', 'warning', 'default']);
  });
});

describe('TaskPropertyValue', () => {
  test('the value and the note each take their own tone', () => {
    expect(rule(css('task/task-property-value.module.css'), '.toned')).toBe(
      'color: var(--tone-ink);'
    );
    render(
      <TaskPropertyValue tone="danger" note="2 days overdue" noteTone="danger">
        Oct 19
      </TaskPropertyValue>
    );
    expect(screen.getByText('Oct 19').getAttribute('data-tone')).toBe('danger');
    expect(screen.getByText('2 days overdue').getAttribute('data-tone')).toBe(
      'danger'
    );
  });
});

describe('TaskActivityList', () => {
  test('a toned mark fills in its hue; what needs action colours its label', () => {
    const sheet = css('task/task-activity-list.module.css');
    for (const tone of ['accent', 'danger', 'warning', 'success', 'info']) {
      expect(sheet).toContain(`.${tone} .mark`);
    }
    expect(sheet).toContain('background: var(--tone);');
    expect(sheet).toContain('.danger .label, .warning .label');
    // Success and info keep the ink label beside their coloured mark.
    expect(sheet).not.toContain('.success .label');
    expect(sheet).not.toContain('--accent)');
    const view = render(
      <TaskActivityList
        items={[
          { id: '1', at: 'Oct 21', label: 'Assigned', tone: 'success' },
          { id: '2', at: 'Oct 20', label: 'Assigning failed', tone: 'danger' },
        ]}
      />
    );
    expect(
      [...view.container.querySelectorAll('li')].map((li) =>
        li.getAttribute('data-tone')
      )
    ).toEqual(['success', 'danger']);
  });
});

describe('the rest of the task view and the editors', () => {
  test('an open relation nobody holds reads "Unassigned" in amber', () => {
    expect(rule(css('task/task-relation-list.module.css'), '.unassigned')).toBe(
      'font-weight: var(--fw-medium); color: var(--amber);'
    );
  });

  test('a refused field and an over-long text are red', () => {
    // Gr8r's error field: a red edge thickened by a 1px red shadow (the
    // comment box draws it on the box, data-invalid mirroring the
    // textarea's aria-invalid), with a soft red halo on focus.
    for (const [file, selector] of [
      ['edit/date-field.module.css', ".input[aria-invalid='true']"],
      ['edit/inline-text-field.module.css', ".input[aria-invalid='true']"],
      ['edit/text-area-editor.module.css', ".root[data-invalid='true']"],
    ] as const) {
      expect([file, rule(css(file), selector)]).toEqual([
        file,
        'border-color: var(--red); box-shadow: 0 0 0 1px var(--red);',
      ]);
    }
    const area = css('edit/text-area-editor.module.css');
    expect(rule(area, ".count[data-over='true']")).toBe(
      'color: var(--red); font-weight: var(--fw-medium);'
    );
    expect(rule(area, '.armed')).toBe(
      'color: var(--amber); font-weight: var(--fw-medium);'
    );
  });
});
