import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { DependencyGraph } from '../src/graph/dependency-graph';
import { defaultGraphLegend, GraphLegend } from '../src/graph/graph-legend';
import type { GraphNodeData, GraphNodeTone } from '../src/graph/types';

// Status colours on the dependency graph (owner decision 2026-10-22,
// docs/architecture.md §8.2), in the Gr8r look (2026-10-23): overdue is a
// red tint inside a red edge, at risk / unassigned a 2px amber edge,
// cycles dash red, risk chains run amber, closed or inactive marks go grey
// with their shapes kept, and the flags are sentence-case Chips in their
// tones. The purple accent keeps only selection, the paths being read and
// focus. CSS modules resolve to empty objects under Bun, so the nodes are
// checked through the data-tone they emit and the colours through their
// stylesheets.

afterEach(cleanup);

const srcDir = path.join(import.meta.dir, '..', 'src');

/** A stylesheet under src, comments removed and whitespace collapsed. */
function css(file: string): string {
  return readFileSync(path.join(srcDir, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ');
}

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(sheet: string, selector: string): string {
  const at = sheet.indexOf(`${selector} {`);
  expect([selector, at >= 0]).toEqual([selector, true]);
  const open = sheet.indexOf('{', at);
  return sheet.slice(open + 1, sheet.indexOf('}', open)).trim();
}

function nodeEl(container: HTMLElement, id: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-graph-node="${id}"]`);
  if (el === null) throw new Error(`no node ${id}`);
  return el;
}

const TONES: GraphNodeTone[] = [
  'default',
  'muted',
  'accent',
  'danger',
  'warning',
  'success',
  'info',
];

describe('DependencyGraph node tones', () => {
  test('a status tone reaches the box as data-tone; default and muted do not', () => {
    const nodes: GraphNodeData[] = TONES.map((tone) => ({
      id: tone,
      label: `A ${tone} box`,
      tone,
    }));
    const { container } = render(
      <DependencyGraph
        nodes={nodes}
        edges={TONES.slice(1).map((tone) => ({
          from: 'default',
          to: tone,
          kind: 'default' as const,
        }))}
        ariaSummary="Seven boxes."
        emptyMessage="Nothing."
        onSelect={() => undefined}
      />
    );
    const seen = TONES.map((tone) => [
      tone,
      nodeEl(container, tone).getAttribute('data-tone'),
    ]);
    expect(seen).toEqual([
      ['default', null],
      ['muted', null],
      ['accent', 'accent'],
      ['danger', 'danger'],
      ['warning', 'warning'],
      ['success', 'success'],
      ['info', 'info'],
    ]);
  });

  test('a link box carries its tone on the link itself', () => {
    const { container } = render(
      <DependencyGraph
        nodes={[
          { id: 'a', label: 'Blocker', tone: 'danger', href: '/a' },
          { id: 'b', label: 'Waiter', tone: 'default', href: '/b' },
        ]}
        edges={[{ from: 'a', to: 'b', kind: 'risk' }]}
        ariaSummary="Two boxes."
        emptyMessage="Nothing."
      />
    );
    const link = nodeEl(container, 'a').querySelector('a');
    expect(link?.getAttribute('data-tone')).toBe('danger');
    expect(
      nodeEl(container, 'b').querySelector('a')?.hasAttribute('data-tone')
    ).toBe(false);
  });
});

describe('DependencyGraph colours (dependency-graph.module.css)', () => {
  const sheet = css('graph/dependency-graph.module.css');

  test('risk chains run amber and cycles dash red, both text-safe for counts', () => {
    expect(rule(sheet, '.edgeRisk')).toContain('color: var(--amber)');
    expect(rule(sheet, '.edgeCycle')).toContain('color: var(--red)');
    expect(rule(sheet, '.edgeCycle .edgeLine')).toContain(
      'stroke-dasharray: 6 3.5'
    );
    // Under Risk a risk chain is heavier too: weight, not only hue.
    expect(
      rule(sheet, ":where(.graph[data-highlight='risk']) .edgeRisk .edgeLine")
    ).toBe('stroke-width: 2;');
    // A count on a coloured edge is text: the hues are text-safe now.
    expect(rule(sheet, '.edgeRisk')).toContain('--edge-ink: var(--amber)');
    expect(rule(sheet, '.edgeCycle')).toContain('--edge-ink: var(--red)');
    expect(rule(sheet, '.weight text')).toContain(
      'fill: var(--edge-ink, currentcolor)'
    );
  });

  test('overdue tints the box red inside a 1px red edge, never a flood', () => {
    const tint = rule(sheet, '.node.overdueNode');
    expect(tint).toContain('border-color: var(--red)');
    expect(tint).toContain('border-width: 1px');
    expect(tint).toContain(
      'background: linear-gradient(var(--red-soft), var(--red-soft)) var(--surface)'
    );
    // No token swap: the words, marks and chips keep their own colours.
    expect(tint).not.toContain('--text:');
    expect(tint).not.toContain('color: var(--on-red)');
  });

  test('a cycle is a dashed red outline outside the box', () => {
    // 2px: Chrome draws a 1.5px border at 1px.
    expect(rule(sheet, '.cycle::before')).toContain(
      'border: 2px dashed var(--red)'
    );
    // Past the path rings and the focus ring (1-3px out).
    expect(rule(sheet, '.cycle::before')).toContain('inset: -6px');
  });

  test('a status tone is a 2px edge in its hue; muted stays quiet', () => {
    // 2px, never 1.5px: Chrome draws 1.5px at 1px, the weight of ready's
    // edge, so the weight would no longer tell ready from blocked.
    expect(rule(sheet, '.toned')).toContain('border: 2px solid var(--tone)');
    expect(rule(sheet, '.toned')).not.toContain('1.5px');
    // The extra pixel goes back to the padding, so the content never moves.
    expect(rule(sheet, '.toned')).toContain('padding: 9px 11px');
    const muted = rule(sheet, '.toneMuted');
    for (const hue of ['green', 'amber', 'red', 'open', 'quiet']) {
      expect(muted).toContain(`--glyph-${hue}: var(--gray)`);
    }
    // Done keeps its neutral --text diamond in a quiet box.
    expect(muted).not.toContain('--glyph-ink');
    expect(rule(sheet, '.toneMuted > .text > .label')).toBe(
      'color: var(--text-3);'
    );
  });

  test('the status mark is StatusMark’s diamond family, in the status hues', () => {
    const node = rule(sheet, '.node');
    expect(node).toContain('--glyph-green: var(--green)');
    expect(node).toContain('--glyph-amber: var(--amber)');
    expect(node).toContain('--glyph-red: var(--red)');
    expect(node).toContain('--glyph-open: var(--text-2)');
    expect(node).toContain('--glyph-quiet: var(--text-3)');
    // Done is the neutral --text (never the green: it would match the red
    // fill without red-green vision), through --glyph-ink.
    expect(node).toContain('--glyph-ink: var(--text)');
    // The diamond: a square turned 45° with a 2px edge.
    const diamond = rule(sheet, '.glyph::before');
    expect(diamond).toContain('inset: 14.6%');
    expect(diamond).toContain('border: 2px solid currentcolor');
    expect(diamond).toContain('transform: rotate(45deg)');
    expect(rule(sheet, '.done')).toBe('color: var(--glyph-ink);');
    expect(rule(sheet, '.done::before')).toBe('background: currentcolor;');
    expect(rule(sheet, '.done::after')).toContain(
      'border: solid var(--surface)'
    );
    expect(rule(sheet, '.on_track')).toBe('color: var(--glyph-green);');
    expect(rule(sheet, '.at_risk')).toBe('color: var(--glyph-amber);');
    expect(rule(sheet, '.at_risk::before')).toContain(
      'linear-gradient(135deg, transparent 50%, currentcolor 50%)'
    );
    expect(rule(sheet, '.overdue')).toBe('color: var(--glyph-red);');
    expect(rule(sheet, '.overdue::before')).toBe('background: currentcolor;');
    expect(rule(sheet, '.missing::before')).toBe('border-style: dotted;');
    expect(rule(sheet, '.open')).toBe('color: var(--glyph-open);');
  });

  test('flags are Chips: Unassigned tinted amber, Overdue a red dot pill', () => {
    const { container } = render(
      <DependencyGraph
        nodes={[
          {
            id: 'a',
            label: 'Blocker',
            tone: 'danger',
            tags: ['Unassigned', 'Overdue', 'Cycle', 'No lead', '+2 more'],
          },
          { id: 'b', label: 'Waiter', tone: 'default', tags: ['Inactive'] },
        ]}
        edges={[{ from: 'a', to: 'b', kind: 'risk' }]}
        ariaSummary="Two boxes."
        emptyMessage="Nothing."
      />
    );
    const chip = (id: string, word: string) =>
      [...nodeEl(container, id).querySelectorAll('[data-tone]')].find(
        (el) => el.textContent === word
      );
    const look = (id: string, word: string) => {
      const el = chip(id, word);
      return [
        word,
        el?.getAttribute('data-tone') ?? null,
        el?.hasAttribute('data-filled') ?? null,
      ];
    };
    expect(
      ['Unassigned', 'Overdue', 'Cycle', 'No lead', '+2 more'].map((word) =>
        look('a', word)
      )
    ).toEqual([
      ['Unassigned', 'warning', true],
      ['Overdue', 'danger', false],
      ['Cycle', 'danger', true],
      ['No lead', 'warning', false],
      ['+2 more', 'default', false],
    ]);
    expect(look('b', 'Inactive')).toEqual(['Inactive', 'muted', false]);
  });

  test('hover is Gr8r’s --surface-2 fill, never the accent flood', () => {
    const hover = rule(
      sheet,
      '.node:not(.selected, .overdueNode, .locked):hover'
    );
    expect(hover).toBe('background: var(--surface-2);');
    // The one accent fill is the lock strip's Open, the primary button.
    expect(sheet.match(/background: var\(--accent\);/g)).toHaveLength(1);
  });

  test('no status rule uses the purple accent', () => {
    for (const selector of [
      '.edgeRisk',
      '.edgeCycle',
      '.done',
      '.on_track',
      '.at_risk',
      '.overdue',
      '.missing',
      '.toned',
      '.toneEdge',
      '.toneMuted',
      '.node.overdueNode',
      '.cycle::before',
      '.cluster',
      '.clusterMuted',
    ]) {
      expect([selector, rule(sheet, selector).includes('accent')]).toEqual([
        selector,
        false,
      ]);
    }
  });

  test('forced colours keep every diamond’s shape', () => {
    const forced = sheet.slice(sheet.indexOf('@media (forced-colors: active)'));
    const glyph = rule(forced, '.glyph');
    expect(glyph).toContain('forced-color-adjust: none');
    expect(glyph).toContain('color: CanvasText');
    expect(rule(forced, '.done::after')).toBe('border-color: Canvas;');
  });
});

describe('GraphLegend colours', () => {
  const sheet = css('graph/graph-legend.module.css');

  test('the default legend names needs action with the amber edge', () => {
    const marks = defaultGraphLegend.map((item) => item.mark);
    expect(marks).toContain('node-warning');
    expect(marks).not.toContain('node-accent');
    const { container } = render(<GraphLegend />);
    expect(
      container.querySelector('[data-mark="node-warning"]')
    ).not.toBeNull();
  });

  test('swatches draw the graph’s own status hues', () => {
    expect(rule(sheet, '.nodeWarning')).toContain(
      'border: 2px solid var(--amber)'
    );
    expect(rule(sheet, '.nodeOverdue')).toContain('border-color: var(--red)');
    expect(rule(sheet, '.nodeOverdue')).toContain('var(--red-soft)');
    expect(rule(sheet, '.nodeCycle::before')).toContain(
      'border: 2px dashed var(--red)'
    );
    expect(rule(sheet, '.edgeRisk')).toContain('color: var(--amber)');
    expect(rule(sheet, '.edgeCycle')).toContain('color: var(--red)');
  });
});

describe('MermaidSource colours', () => {
  test('a refused copy says so in red; a copy that worked in green', () => {
    const sheet = css('graph/mermaid-source.module.css');
    expect(rule(sheet, ".copy[data-state='failed'] .copyIcon")).toBe(
      'color: var(--red);'
    );
    expect(rule(sheet, ".copy[data-state='copied'] .copyIcon")).toBe(
      'color: var(--green);'
    );
    // Neither is the accent: the result is a status word, not a selection.
    expect(sheet).not.toContain('accent');
  });
});
