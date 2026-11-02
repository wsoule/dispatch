import { act, render } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { runSteps } from '../../lib/runStep';
import { FlightNodeCard, type FlightNodeView } from './FlightNodeCard';
import styles from './FlightNodeCard.module.css';

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
    // bun loads a CSS module as an empty map (every class undefined), so the rendered
    // class alone proves nothing: the source must put `.card` on the card's button, the
    // sheet's `.card` must hold the layer, and the rendered class is what the module names.
    const source = readFileSync(
      join(import.meta.dir, 'FlightNodeCard.tsx'),
      'utf8'
    );
    expect(source).toMatch(
      /data-slot="flight-node"[^<]*className=\{styles\.card\}/
    );
    expect(
      container
        .querySelector('[data-slot=flight-node]')
        ?.getAttribute('class') ?? ''
    ).toBe(styles.card ?? '');
    const css = readFileSync(
      join(import.meta.dir, 'FlightNodeCard.module.css'),
      'utf8'
    ).replace(/\/\*[\s\S]*?\*\//g, '');
    const at = css.indexOf('\n.card {');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(css.slice(at, css.indexOf('}', at))).toContain(
      'will-change: transform'
    );
  });
});

describe('FlightNodeCard tones', () => {
  function card(container: HTMLElement) {
    return container.querySelector('[data-slot=flight-node]');
  }

  test('running and review cards take their status edge; the rest stay neutral', () => {
    const tones = (
      ['done', 'running', 'teammate', 'review', 'queued', 'blocked'] as const
    ).map((state) => {
      const { container, unmount } = renderCard({ state });
      const tone = card(container)?.getAttribute('data-tone') ?? null;
      unmount();
      return [state, tone];
    });
    expect(tones).toEqual([
      ['done', null],
      ['running', 'info'],
      ['teammate', null],
      ['review', 'success'],
      ['queued', null],
      ['blocked', null],
    ]);
  });

  test('a sentence takes its tone through toneText; done and ready stay neutral', () => {
    const tones = (
      [
        'done',
        'working',
        'waiting',
        'review',
        'failed',
        'ready',
        'muted',
      ] as const
    ).map((tone) => {
      const { container, unmount } = renderCard({ tone });
      const line = container.querySelector('[data-slot=flight-node-sentence]');
      const shown = [
        tone,
        line?.getAttribute('data-tone') ?? null,
        line?.classList.contains('toneText') ?? false,
      ];
      unmount();
      return shown;
    });
    expect(tones).toEqual([
      ['done', null, false],
      ['working', 'info', true],
      ['waiting', 'warning', true],
      ['review', 'success', true],
      ['failed', 'danger', true],
      ['ready', null, false],
      ['muted', 'muted', true],
    ]);
  });

  test('a landing sentence reads in the in-progress tone', () => {
    const { container } = renderCard({ landing: 'verifying' });
    expect(
      container
        .querySelector('[data-slot=flight-node-sentence]')
        ?.getAttribute('data-tone')
    ).toBe('info');
  });

  test('the focused and critical hooks stay on the card', () => {
    const { container } = render(
      <FlightNodeCard
        {...view({ critical: true })}
        focused
        onActivate={() => {}}
      />
    );
    const node = card(container);
    expect(node?.getAttribute('data-focused')).toBe('true');
    expect(node?.getAttribute('data-critical')).toBe('true');
    expect(node?.id).toBe('flight-node-t-1');
    expect(node?.getAttribute('tabindex')).toBe('-1');
  });
});
