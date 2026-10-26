import type { SetupReport } from '@dispatch-foo/core/browser';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, mock, test } from 'bun:test';

import { SetupBanner, setupProblem } from './SetupBanner';

const base: SetupReport = {
  defaultProvider: 'claude',
  providers: [],
  steps: [{ id: 'git', status: 'ok', message: '' }],
};

test('renders nothing when every step is ok or unknown', () => {
  const { container } = render(
    <SetupBanner
      report={{
        ...base,
        steps: [...base.steps, { id: 'agent', status: 'unknown', message: '' }],
      }}
      onOpen={() => {}}
    />
  );
  expect(container.textContent).toBe('');
});

test('names the first problem and links to Setup', () => {
  const onOpen = mock(() => {});
  render(
    <SetupBanner
      report={{
        ...base,
        steps: [
          ...base.steps,
          {
            id: 'agent',
            status: 'needs-action',
            message: "Claude Code isn't signed in.",
          },
        ],
      }}
      onOpen={onOpen}
    />
  );
  expect(screen.getByText("Claude Code isn't signed in.")).toBeTruthy();
  fireEvent.click(screen.getByText('Fix it'));
  expect(onOpen).toHaveBeenCalled();
});

test('setupProblem names the first step that wants a person, or nothing', () => {
  expect(setupProblem(undefined)).toBeUndefined();
  expect(setupProblem(base)).toBeUndefined();
  const missing = {
    id: 'agent',
    status: 'missing',
    message: 'No agent.',
  } as const;
  expect(
    setupProblem({ ...base, steps: [...base.steps, missing] })?.message
  ).toBe('No agent.');
});
