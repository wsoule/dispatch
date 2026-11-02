import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'bun:test';

import { run } from './pageHost.test-helper';
import { RunStrip } from './RunStrip';

// The run strip's run picker: plain text for one run, else one "Run" picker whose options
// lead with each run's compact state mark, so the failed run and the finished one read
// apart without opening either.

afterEach(cleanup);

describe('RunPicker', () => {
  test('a single run is plain text, not a picker', () => {
    const only = run({ state: 'finished' });
    render(<RunStrip run={only} runs={[only]} onSelectRun={() => {}} />);
    expect(screen.queryByRole('button', { name: /^Run: / })).toBeNull();
  });

  test('each option says its run’s state, and picking one selects it', async () => {
    const failed = run({ id: 'r-1', state: 'failed' });
    const finished = run({
      id: 'r-2',
      state: 'finished',
      kind: 'review',
      updatedAt: '2026-09-24T10:00:00.000Z',
    });
    const picked: string[] = [];
    render(
      <RunStrip
        run={finished}
        runs={[failed, finished]}
        onSelectRun={(id) => picked.push(id)}
      />
    );
    const trigger = screen.getByRole('button', { name: /^Run: r-2/ });
    await act(async () => {
      trigger.click();
      await Promise.resolve();
    });
    const list = screen.getByRole('listbox', { name: 'Run' });
    const options = within(list).getAllByRole('option');
    expect(options).toHaveLength(2);
    // The state mark is a role="img" named by the state, inside each option.
    expect(
      within(options[0]).getByRole('img').getAttribute('aria-label')
    ).toMatch(/^Failed/);
    expect(options[0].textContent).toContain('r-1');
    expect(
      within(options[1]).getByRole('img').getAttribute('aria-label')
    ).toMatch(/^Review/);
    await act(async () => {
      options[0].click();
      await Promise.resolve();
    });
    expect(picked).toEqual(['r-1']);
  });
});
