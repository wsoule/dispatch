import type { JudgmentStatus } from '@dispatch/client';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';

import { JudgmentStatusRow, judgmentSummary } from './JudgmentStatusRow';

const base: JudgmentStatus = {
  configured: true,
  model: 'jev-latest',
  lastFailure: null,
};

describe('judgmentSummary', () => {
  test('says off without a key, connected with one, failing after an error', () => {
    expect(judgmentSummary({ ...base, configured: false }, null).tone).toBe(
      'off'
    );
    expect(judgmentSummary(base, null).tone).toBe('ok');
    expect(
      judgmentSummary(
        {
          ...base,
          lastFailure: {
            feature: 'overseer-topic',
            message: '401',
            at: new Date().toISOString(),
          },
        },
        null
      )
    ).toMatchObject({ tone: 'bad' });
  });

  test('a test result wins: reachable with its time, or the error', () => {
    expect(judgmentSummary(base, { ok: true, latencyMs: 142 }).text).toBe(
      'Reachable · answered in 142ms'
    );
    expect(judgmentSummary(base, { ok: false, error: 'timeout' }).text).toBe(
      'Unreachable · timeout'
    );
  });
});

test('Test makes one probe and shows its answer', async () => {
  const calls: boolean[] = [];
  const client = {
    judgmentStatus: (probe?: boolean) => {
      calls.push(probe === true);
      return Promise.resolve(
        probe === true
          ? { ...base, probe: { ok: true as const, latencyMs: 99 } }
          : base
      );
    },
  };
  render(<JudgmentStatusRow client={client} port={1} />);
  await screen.findByText('Key set · no failures since the daemon started');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(await screen.findByText('Reachable · answered in 99ms')).toBeTruthy();
  expect(calls).toContain(true);
});
