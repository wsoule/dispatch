import { describe, expect, test } from 'bun:test';

import {
  assigneeLabel,
  kindLabel,
  parseTaskSections,
  priorityLabel,
  priorityTone,
  sectionOrDash,
  statusLabel,
} from './taskDisplay';

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

describe('statusLabel', () => {
  test('title-cases the canonical statuses', () => {
    expect(statusLabel('working')).toBe('Working');
    expect(statusLabel('review')).toBe('Review');
  });

  test('title-cases a single-word status', () => {
    expect(statusLabel('draft')).toBe('Draft');
  });

  test('leaves a custom multi-hyphen status readable', () => {
    expect(statusLabel('waiting-on-design')).toBe('Waiting On Design');
  });

  test('drops empty segments rather than emitting stray spaces', () => {
    expect(statusLabel('done--')).toBe('Done');
  });
});

describe('priorityLabel', () => {
  test('names every priority, with an explicit "No priority" for none', () => {
    expect(priorityLabel('none')).toBe('No priority');
    expect(priorityLabel('low')).toBe('Low');
    expect(priorityLabel('medium')).toBe('Medium');
    expect(priorityLabel('high')).toBe('High');
    expect(priorityLabel('urgent')).toBe('Urgent');
  });
});

describe('assigneeLabel', () => {
  test('reads none as Unassigned and the bare kinds by name', () => {
    expect(assigneeLabel('none')).toBe('Unassigned');
    expect(assigneeLabel('agent')).toBe('Agent');
    expect(assigneeLabel('human')).toBe('Human');
  });

  test('names a handled ref by its handle', () => {
    expect(assigneeLabel('human:wyat')).toBe('wyat');
    expect(assigneeLabel('agent:wyat/claude')).toBe('claude');
  });

  test('falls back to the raw value for a malformed ref, and Unassigned for a missing one', () => {
    expect(assigneeLabel('robot')).toBe('robot');
    expect(assigneeLabel(null)).toBe('Unassigned');
    expect(assigneeLabel('')).toBe('Unassigned');
  });
});

describe('kindLabel', () => {
  test('labels the kinds', () => {
    expect(kindLabel('task')).toBe('Task');
    expect(kindLabel('milestone')).toBe('Milestone');
  });
});
