import type { Finding } from '@dispatch/client';
import type { CommandEvidence, MutationEvidence } from '@dispatch/core/browser';
import { render, screen } from '@testing-library/react';
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
  expect(screen.getByText(/dead guard, or a vacuous test/i)).toBeDefined();
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

test('the review button appears only when starting one is possible', () => {
  const { rerender } = render(<ReviewCasePanel {...empty} />);
  expect(screen.queryByRole('button', { name: /ask an agent/i })).toBeNull();

  rerender(<ReviewCasePanel {...empty} onStartAiReview={async () => {}} />);
  expect(screen.getByRole('button', { name: /ask an agent/i })).toBeDefined();
});
