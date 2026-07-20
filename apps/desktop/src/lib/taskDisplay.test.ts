import { describe, expect, test } from 'bun:test';

import {
  parseTaskSections,
  priorityTone,
  sectionOrDash,
  statusTone,
} from './taskDisplay';

describe('statusTone', () => {
  test('maps each built-in status to its dedicated tone', () => {
    expect(statusTone('in-progress')).toBe('blue');
    expect(statusTone('in-review')).toBe('amber');
    expect(statusTone('done')).toBe('green');
    expect(statusTone('cancelled')).toBe('red');
  });

  test('falls back to gray for backlog/todo and any custom status', () => {
    expect(statusTone('backlog')).toBe('gray');
    expect(statusTone('todo')).toBe('gray');
    expect(statusTone('triage')).toBe('gray');
  });
});

describe('priorityTone', () => {
  test('urgent and high get a tone', () => {
    expect(priorityTone('urgent')).toBe('red');
    expect(priorityTone('high')).toBe('amber');
  });

  test('medium/low/none render no pill at all', () => {
    expect(priorityTone('medium')).toBeNull();
    expect(priorityTone('low')).toBeNull();
    expect(priorityTone('none')).toBeNull();
  });
});

describe('parseTaskSections / sectionOrDash', () => {
  test('splits a task body into heading -> content sections', () => {
    const body =
      '## Description\n\nDoes the thing.\n\n## Acceptance Criteria\n\n- [ ] works\n\n## Activity\n\n';
    const sections = parseTaskSections(body);
    expect(sections.get('Description')).toBe('Does the thing.');
    expect(sections.get('Acceptance Criteria')).toBe('- [ ] works');
  });

  test('sectionOrDash falls back to an em dash for a missing or empty section', () => {
    const sections = parseTaskSections('## Description\n\n\n\n## Activity\n');
    expect(sectionOrDash(sections, 'Description')).toBe('—');
    expect(sectionOrDash(sections, 'Nonexistent')).toBe('—');
  });
});
