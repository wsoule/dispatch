import type { ExecutorsResponse } from '@dispatch/client';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'bun:test';

import type { DispatchReadiness } from '../../../lib/dispatchReadiness';
import { DispatchCard, type DispatchCardProps } from './DispatchCard';

// The Spec mode's dispatch card on its own: the three pickers keep the property names the
// page always had as the start of their "Label: Value" names, and the Dispatch button says
// its D key to assistive tech while the keycap stays visual.

afterEach(cleanup);

const READY: DispatchReadiness = {
  checks: [{ id: 'spec', tone: 'pass', label: 'Spec reads well' }],
  canDispatch: true,
  closed: false,
  blocked: false,
  warnings: 0,
};

const EXECUTORS: ExecutorsResponse = {
  default: 'claude',
  executors: [
    {
      name: 'claude',
      reportsCost: true,
      reportsTurns: true,
      enforcesCaps: true,
    },
    {
      name: 'codex',
      reportsCost: false,
      reportsTurns: true,
      enforcesCaps: false,
    },
    // The daemon's test executor is never offered.
    {
      name: 'fake',
      reportsCost: false,
      reportsTurns: false,
      enforcesCaps: false,
    },
  ],
};

function mount(overrides: Partial<DispatchCardProps> = {}) {
  return render(
    <DispatchCard
      readiness={READY}
      live={false}
      starting={false}
      executors={EXECUTORS}
      defaultModel={undefined}
      onDispatch={() => {}}
      onOpenRun={() => {}}
      onOpenTask={() => {}}
      enriching={false}
      onAddWrites={() => {}}
      {...overrides}
    />
  );
}

describe('DispatchCard', () => {
  test('the pickers are named by their property, then their value', () => {
    mount();
    expect(
      screen.getByRole('button', { name: 'Executor: claude' })
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Model: \S/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Effort: \S/ })).toBeTruthy();
  });

  test('the executor picker lists the real executors only', async () => {
    mount();
    await act(async () => {
      screen.getByRole('button', { name: 'Executor: claude' }).click();
      await Promise.resolve();
    });
    expect(
      screen.getAllByRole('option').map((option) => option.textContent)
    ).toEqual(['claude', 'codex']);
  });

  test('Dispatch names its D key while the keycap is visual', () => {
    mount();
    const button = screen.getByRole('button', { name: 'Dispatch (D)' });
    expect(
      button.querySelector('kbd')?.closest('[aria-hidden]')
    ).not.toBeNull();
  });

  test('a blocked task dispatches anyway, on no key', () => {
    mount({
      readiness: {
        ...READY,
        blocked: true,
        checks: [{ id: 'blockers', tone: 'block', label: 'Waits on 1 task' }],
      },
    });
    expect(
      screen.getByRole('button', { name: 'Dispatch anyway' }).textContent
    ).toBe('Dispatch anyway');
  });
});
