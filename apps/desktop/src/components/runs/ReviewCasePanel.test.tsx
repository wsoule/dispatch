import type { Finding } from '@dispatch/client';
import type { CommandEvidence, MutationEvidence } from '@dispatch/core/browser';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { ReviewCasePanel } from './ReviewCasePanel';

const cmd = (over: Partial<CommandEvidence> = {}): CommandEvidence => ({
  command: 'bun test',
  exitCode: 0,
  durationMs: 1200,
  summary: '158 pass, 0 fail',
  at: '2026-08-03T00:00:00.000Z',
  ...over,
});

const mut = (testsFailed: number): MutationEvidence => ({
  guard: 'taskId guard',
  file: 'a.ts',
  testsFailed,
  at: '2026-08-03T00:00:00.000Z',
});

const finding = (over: Partial<Finding> = {}): Finding => ({
  id: 'f-000001',
  taskId: 't-1',
  runId: null,
  severity: 'critical',
  verdict: 'open',
  title: 'widens the PATCH surface',
  detail: 'anyone can set status now',
  file: 'api.ts',
  line: 88,
  ruling: null,
  round: 0,
  createdAt: '2026-08-03T00:00:00.000Z',
  updatedAt: '2026-08-03T00:00:00.000Z',
  raisedBy: '',
  ...over,
});

const empty = { evidence: [], mutations: [], findings: [], decisions: [] };

test('a run with no recorded verification says so, rather than rendering blank', () => {
  render(<ReviewCasePanel {...empty} />);
  expect(screen.getByText(/recorded no verification/i)).toBeDefined();
});

test('a failed command is distinguishable from a passing one', () => {
  const { container } = render(
    <ReviewCasePanel
      {...empty}
      evidence={[cmd({ command: 'bun run lint', exitCode: 1 })]}
    />
  );
  expect(screen.getByText('bun run lint')).toBeDefined();
  expect(container.innerHTML).toContain('text-state-failed');
});

// The single highest-signal red flag in reviewing agent work, and it was invisible before.
test('a guard that broke no tests is flagged as dead or vacuous', () => {
  render(<ReviewCasePanel {...empty} mutations={[mut(0)]} />);
  expect(screen.getByText(/dead guard or vacuous test/i)).toBeDefined();
});

test('a guard whose removal broke tests is not flagged', () => {
  render(<ReviewCasePanel {...empty} mutations={[mut(3)]} />);
  expect(screen.queryByText(/dead guard/i)).toBeNull();
  expect(screen.getByText('3 tests failed')).toBeDefined();
});

// An empty finding set means nobody looked. Reading it as "clean" is the one way this panel
// could actively mislead a reviewer into approving.
test('no findings reads as "no review has run", never as clean', () => {
  render(<ReviewCasePanel {...empty} />);
  expect(screen.getByText(/no agent review has run/i)).toBeDefined();
  expect(screen.queryByText(/no findings/i)).toBeNull();
});

test('open findings render with their location', () => {
  render(<ReviewCasePanel {...empty} findings={[finding()]} />);
  expect(screen.getByText('widens the PATCH surface')).toBeDefined();
  expect(screen.getByText('api.ts:88')).toBeDefined();
  expect(screen.queryByText(/no agent review has run/i)).toBeNull();
});

test('an adjudicated finding does not count as open', () => {
  render(
    <ReviewCasePanel {...empty} findings={[finding({ verdict: 'parked' })]} />
  );
  expect(screen.getByText(/no agent review has run/i)).toBeDefined();
});

const check = (over: Partial<Finding> = {}): Finding =>
  finding({ raisedBy: 'none', severity: 'minor', ...over });

const legacyChecks = ['a.ts', 'b.ts', 'c.ts'].map((path, i) =>
  check({
    id: `f-c${i}`,
    title: `file changed outside declared writes: ${path}`,
    file: path,
  })
);

test('a rule that fired across many files renders as one collapsed row', () => {
  render(<ReviewCasePanel {...empty} findings={legacyChecks} />);
  expect(
    screen.getByText('file changed outside declared writes')
  ).toBeDefined();
  expect(screen.getByText('3 files')).toBeDefined();
  expect(screen.queryByText('a.ts')).toBeNull();
});

test('expanding a rule lists the paths it covers', () => {
  render(<ReviewCasePanel {...empty} findings={legacyChecks} />);
  fireEvent.click(screen.getByRole('button', { name: /outside declared/i }));
  expect(screen.getByText('a.ts')).toBeDefined();
  expect(screen.getByText('c.ts')).toBeDefined();
});

// A rule firing is not a review having run. Saying otherwise is the one way
// this panel could mislead a reviewer into approving.
test('checks alone still read as "no review has run"', () => {
  render(<ReviewCasePanel {...empty} findings={legacyChecks} />);
  expect(screen.getByText(/no agent review has run/i)).toBeDefined();
});

test('a check never counts toward the agent review section', () => {
  render(
    <ReviewCasePanel
      {...empty}
      findings={[
        finding({ id: 'f-1', severity: 'important' }),
        ...legacyChecks,
      ]}
    />
  );
  const heading = screen.getByText('Agent review').closest('div');
  expect(heading?.textContent).toBe('Agent review1');
});

// Once per group, not once per row — the severity was repeated down every
// row before, which is what made a long list read as undifferentiated.
test('a severity is named once for the group, not on every row', () => {
  render(
    <ReviewCasePanel
      {...empty}
      findings={[
        finding({ id: 'f-1', severity: 'critical' }),
        finding({ id: 'f-2', severity: 'critical', title: 'another one' }),
        finding({ id: 'f-3', severity: 'minor', title: 'a nit' }),
      ]}
    />
  );
  expect(screen.getAllByText('critical')).toHaveLength(1);
  expect(screen.getAllByText('minor')).toHaveLength(1);
  expect(screen.getByText('another one')).toBeDefined();
});

test('a long detail clamps until asked for the rest', () => {
  const wall = 'x'.repeat(400);
  render(<ReviewCasePanel {...empty} findings={[finding({ detail: wall })]} />);
  fireEvent.click(screen.getByRole('button', { name: 'more' }));
  expect(screen.getByRole('button', { name: 'less' })).toBeDefined();
});

test('a short detail gets no toggle', () => {
  render(
    <ReviewCasePanel {...empty} findings={[finding({ detail: 'brief' })]} />
  );
  expect(screen.queryByRole('button', { name: 'more' })).toBeNull();
});

test('the review button appears only when starting one is possible', () => {
  const { rerender } = render(<ReviewCasePanel {...empty} />);
  expect(screen.queryByRole('button', { name: /ask an agent/i })).toBeNull();

  rerender(<ReviewCasePanel {...empty} onStartAiReview={async () => {}} />);
  expect(screen.getByRole('button', { name: /ask an agent/i })).toBeDefined();
});

test('checked findings go to onFixFindings; the button says how many', async () => {
  const fixed: string[][] = [];
  render(
    <ReviewCasePanel
      {...empty}
      findings={[finding(), finding({ id: 'f-000002', title: 'second' })]}
      onFixFindings={(picked) => {
        fixed.push(picked.map((f) => f.id));
        return Promise.resolve();
      }}
    />
  );
  fireEvent.click(
    screen.getByLabelText('Select finding: widens the PATCH surface')
  );
  const button = screen.getByRole('button', { name: /fix 1 selected/i });
  fireEvent.click(button);
  await waitFor(() => expect(fixed).toEqual([['f-000001']]));
});

test('without onFixFindings there are no checkboxes and no fix button', () => {
  render(<ReviewCasePanel {...empty} findings={[finding()]} />);
  expect(screen.queryByLabelText(/select finding/i)).toBeNull();
  expect(screen.queryByRole('button', { name: /fix.*selected/i })).toBeNull();
});
