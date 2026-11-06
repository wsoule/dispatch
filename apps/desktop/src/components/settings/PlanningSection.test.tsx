import type { ConfigPatch } from '@dispatch-foo/core/browser';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { testConfig } from './fixtures.test-helper';
import { PlanningSection } from './PlanningSection';

// Settings → Planning saves field by field into config.yml's planning block.

const PEOPLE = [
  { ref: 'human:ana', name: 'Ana' },
  { ref: 'human:dev', name: 'Dev' },
];

function mount(planning = testConfig.planning) {
  const saved: ConfigPatch[] = [];
  render(
    <PlanningSection
      config={{ ...testConfig, planning }}
      people={PEOPLE}
      onSave={(patch) => Promise.resolve(void saved.push(patch))}
    />
  );
  return saved;
}

test('a tuning number saves on blur; emptying it goes back to the default', () => {
  const saved = mount();
  const field = screen.getByRole('textbox', { name: 'Warn ahead' });
  expect(field.getAttribute('placeholder')).toBe('7');
  fireEvent.change(field, { target: { value: '10' } });
  fireEvent.blur(field);
  expect(saved).toEqual([{ planning: { tuning: { warnLeadDays: 10 } } }]);
});

test('the active statuses toggle, and the last one cannot be cleared', () => {
  const saved = mount({
    tuning: { activeProjectStatuses: ['started'] },
    watchers: [],
    weights: {},
    allocation: 'manual',
    warnings: 'off',
  });
  const started = screen.getByRole('checkbox', { name: 'In progress' });
  expect((started as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Paused' }));
  expect(saved).toEqual([
    { planning: { tuning: { activeProjectStatuses: ['started', 'paused'] } } },
  ]);
});

test('ticking a person makes them a watcher', () => {
  const saved = mount({
    tuning: {},
    watchers: ['human:dev'],
    weights: {},
    allocation: 'manual',
    warnings: 'off',
  });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Ana' }));
  expect(saved).toEqual([
    { planning: { watchers: ['human:dev', 'human:ana'] } },
  ]);
});

test('the allocation mode saves as daily or manual', () => {
  const saved = mount();
  fireEvent.click(screen.getByRole('radio', { name: 'Daily' }));
  expect(saved).toEqual([{ planning: { allocation: 'daily' } }]);
});
