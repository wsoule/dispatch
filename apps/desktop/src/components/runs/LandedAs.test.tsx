import type { RunMeta } from '@dispatch/client';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';

import { LandedAs } from './LandedAs';

function run(over: Partial<RunMeta> = {}): RunMeta {
  return {
    id: 'r-abc123',
    taskId: 't-abc123',
    state: 'finished',
    branch: 'dispatch/t-abc123',
    baseBranch: 'main',
    reviewAction: 'merge',
    reviewedAt: '2026-10-06T20:11:53.000Z',
    mergeCommit: 'a1a7606ac17dee9ae72e5f4bed208ee4a07a2fa1',
    ...over,
  } as RunMeta;
}

describe('LandedAs', () => {
  test('an origin landing names origin/main, links the sha, and says whether it shipped', () => {
    const { container } = render(
      <LandedAs
        run={run({
          landsOn: 'origin',
          pushedToOrigin: true,
          release: { tag: 'v0.39.1', included: false },
        })}
        originWebUrl="https://github.com/wsoule/dispatch"
      />
    );
    expect(container.textContent).toContain('Landed on origin/main');
    expect(container.textContent).toContain('a1a7606');
    expect(container.textContent).toContain('not released yet');
    const link = screen.getByRole('link', { name: /on GitHub/ });
    expect(link.getAttribute('href')).toBe(
      'https://github.com/wsoule/dispatch/commit/a1a7606ac17dee9ae72e5f4bed208ee4a07a2fa1'
    );
  });

  test('a merge that never reached origin says so and offers a one-click retry', async () => {
    const published: string[] = [];
    const { container } = render(
      <LandedAs
        run={run({ landsOn: 'origin', pushedToOrigin: false })}
        originWebUrl="https://github.com/wsoule/dispatch"
        onPublish={(id) => {
          published.push(id);
          return Promise.resolve();
        }}
      />
    );
    expect(container.textContent).toContain(
      'Merged locally — not on GitHub yet'
    );
    expect(container.textContent).not.toContain('Landed');
    // No GitHub link for a commit GitHub does not have.
    expect(screen.queryByRole('link')).toBeNull();
    const retry = screen.getByRole('button', { name: /Push to origin/ });
    await act(async () => {
      fireEvent.click(retry);
      await Promise.resolve();
    });
    expect(published).toEqual(['r-abc123']);
  });

  test('a project with no remote reads as landed locally, with nothing to retry', () => {
    const { container } = render(
      <LandedAs
        run={run({ landsOn: 'local', pushedToOrigin: false })}
        originWebUrl={undefined}
        onPublish={() => Promise.resolve()}
      />
    );
    expect(container.textContent).toContain('Landed locally (no remote)');
    expect(screen.queryByRole('button')).toBeNull();
  });
});
