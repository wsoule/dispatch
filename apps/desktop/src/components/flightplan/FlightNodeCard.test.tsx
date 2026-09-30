import { act, render } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';

import { runSteps } from '../../lib/runStep';
import { FlightNodeCard, type FlightNodeView } from './FlightNodeCard';

function view(overrides: Partial<FlightNodeView> = {}): FlightNodeView {
  return {
    id: 't-1',
    refLabel: 'ENG-1',
    title: 'Cache the index',
    state: 'review',
    glyphStatus: 'In Review',
    sentence: 'Ready for review',
    tone: 'review',
    owner: null,
    startedAt: null,
    runId: null,
    costUsd: null,
    landing: null,
    critical: false,
    x: 0,
    y: 0,
    ...overrides,
  };
}

function renderCard(overrides: Partial<FlightNodeView> = {}) {
  return render(
    <FlightNodeCard
      {...view(overrides)}
      focused={false}
      onActivate={() => {}}
    />
  );
}

function sentence(container: HTMLElement): string {
  return (
    container.querySelector('[data-slot=flight-node-sentence]')?.textContent ??
    ''
  );
}

describe('FlightNodeCard landing', () => {
  test('a review node in the merge queue says where it is, not "Ready for review"', () => {
    const { container } = renderCard({ landing: 'verifying' });
    expect(sentence(container)).toBe('Landing · verifying');
    // The sentence already says it; the header carries no second badge.
    expect(container.querySelector('[data-slot=landing-badge]')).toBeNull();
    expect(
      container
        .querySelector('[data-slot=flight-node]')
        ?.getAttribute('aria-label')
    ).toBe('ENG-1 Cache the index: Landing · verifying');
  });

  test('any other node in the queue carries the header badge', () => {
    const { container } = renderCard({
      state: 'running',
      sentence: 'Working',
      tone: 'working',
      landing: 'queued',
    });
    expect(sentence(container)).toBe('Working');
    expect(
      container.querySelector('[data-slot=landing-badge]')?.textContent
    ).toBe('Landing');
  });

  test('a node outside the queue is unchanged', () => {
    const { container } = renderCard();
    expect(sentence(container)).toBe('Ready for review');
    expect(container.querySelector('[data-slot=landing-badge]')).toBeNull();
  });
});

describe('FlightNodeCard live step', () => {
  test('a running node replaces "Working" with its run’s latest step', async () => {
    const { container } = renderCard({
      state: 'running',
      sentence: 'Working',
      tone: 'working',
      runId: 'r-step-flight',
    });
    expect(sentence(container)).toBe('Working');
    await act(async () => {
      runSteps.record('r-step-flight', {
        ts: '2026-09-20T00:00:01.000Z',
        kind: 'tool',
        toolName: 'Bash',
        toolInput: { command: 'bun test' },
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(sentence(container)).toBe('Running tests');
    // The accessible name keeps the coarse sentence, so a screen reader is not re-read
    // on every step.
    expect(
      container
        .querySelector('[data-slot=flight-node]')
        ?.getAttribute('aria-label')
    ).toBe('ENG-1 Cache the index: Working');
  });

  test('a node that is not running ignores the run’s steps', async () => {
    await act(async () => {
      runSteps.record('r-step-idle', { ts: '', kind: 'thinking' });
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    const { container } = renderCard({ runId: 'r-step-idle' });
    expect(sentence(container)).toBe('Ready for review');
  });
});

describe('FlightNodeCard layer', () => {
  test('each card is its own compositing layer', () => {
    // A card culled in as the plan pans must not repaint the canvas under the rest.
    const { container } = renderCard();
    expect(
      container
        .querySelector('[data-slot=flight-node]')
        ?.classList.contains('will-change-transform')
    ).toBe(true);
  });
});
