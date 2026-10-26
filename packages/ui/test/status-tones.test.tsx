import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  Checklist,
  Chip,
  Notice,
  PriorityGlyph,
  ProgressRule,
  Register,
  RegisterCell,
  RegisterRow,
  type SemanticTone,
  StateGlyph,
  StatsStrip,
  TaskDetail,
  type UiTone,
} from '../src/index';
import AlertStrip from '../src/shell/alert-strip';
import { hex, THEMES, tokensCss } from './contrast-helpers';

// Status colours on the shared atoms (owner decision 2026-10-22,
// docs/architecture.md §8.2), drawn the Gr8r way (owner decision
// 2026-10-23): tinted chips and alerts, dot pills, toned text, diamonds.
// CSS modules resolve to empty objects under Bun, so the atoms are checked
// through the data-tone they emit, and the colours through their
// stylesheets: status is drawn with the status hues (--red, --amber,
// --green, --blue, --gray) or the data-tone hook (--tone, --tone-ink,
// --tone-soft), never with the purple accent.

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

const SEMANTIC: SemanticTone[] = ['danger', 'warning', 'success', 'info'];

describe('StatusMark colours (status-mark.module.css)', () => {
  const sheet = css('components/status-mark.module.css');

  test('each status takes its hue, in its own shape', () => {
    // The diamond is ::before; its edge and fills are currentColor.
    expect(rule(sheet, '.mark::before')).toContain(
      'border: 2px solid currentColor'
    );
    expect(rule(sheet, '.mark::before')).toContain('transform: rotate(45deg)');
    // Done stays a filled NEUTRAL diamond with a tick: a green fill has the
    // red fill's lightness, so without red-green vision done and overdue
    // would match.
    expect(rule(sheet, '.done')).toBe('color: var(--text);');
    expect(rule(sheet, '.done::before')).toBe('background: currentColor;');
    expect(rule(sheet, '.done::after')).toContain(
      'border: solid var(--surface)'
    );
    expect(rule(sheet, '.on_track')).toBe('color: var(--green);');
    expect(rule(sheet, '.at_risk')).toBe('color: var(--amber);');
    expect(rule(sheet, '.at_risk::before')).toContain(
      'linear-gradient(135deg, transparent 50%, currentColor 50%)'
    );
    expect(rule(sheet, '.overdue')).toBe('color: var(--red);');
    expect(rule(sheet, '.overdue::before')).toBe('background: currentColor;');
    expect(rule(sheet, '.missing')).toBe('color: var(--text-3);');
    expect(rule(sheet, '.missing::before')).toBe('border-style: dotted;');
    expect(rule(sheet, '.open')).toBe('color: var(--text-2);');
    expect(rule(sheet, '.muted')).toBe('color: var(--gray);');
    expect(sheet).not.toMatch(/\.done[^{]*\{[^}]*--green/);
  });

  test('the accent never draws a status', () => {
    expect(sheet).not.toContain('--accent');
  });
});

describe('Chip', () => {
  test('a status tone is emitted as data-tone and drawn in --tone-ink', () => {
    for (const tone of SEMANTIC) {
      const view = render(<Chip tone={tone}>{tone}</Chip>);
      expect(view.container.firstElementChild?.getAttribute('data-tone')).toBe(
        tone
      );
      view.unmount();
    }
    // Unfilled, a status tone is Gr8r's status pill: neutral and bordered,
    // the hue only in a 6px dot (aria-hidden; the word says it).
    const view = render(<Chip tone="info">Running</Chip>);
    const chip = view.container.firstElementChild;
    expect(chip?.querySelectorAll('[aria-hidden="true"]').length).toBe(1);
    view.unmount();
    const sheet = css('tasks/chip.module.css');
    expect(rule(sheet, '.pill')).toBe(
      'border-color: var(--border); background: var(--surface); color: var(--text);'
    );
    expect(rule(sheet, '.dot')).toContain('background: var(--tone);');
  });

  // An inactive project's Linear status ("Paused") is Gr8r's status pill
  // with a grey dot (the approved Projects shot): grey still means
  // inactive. Without `dot` a muted chip stays plain quiet text, and `dot`
  // does nothing on any other tone.
  test('a muted chip with dot is the grey-dot pill; plain without it', () => {
    const dotted = render(
      <Chip tone="muted" dot>
        Paused
      </Chip>
    );
    const pill = dotted.container.firstElementChild;
    expect(pill?.getAttribute('data-tone')).toBe('muted');
    expect(pill?.querySelectorAll('[aria-hidden="true"]').length).toBe(1);
    dotted.unmount();
    const quiet = render(<Chip tone="muted">Inactive</Chip>);
    expect(
      quiet.container.firstElementChild?.querySelectorAll(
        '[aria-hidden="true"]'
      ).length
    ).toBe(0);
    quiet.unmount();
    const neutral = render(<Chip dot>Planned</Chip>);
    expect(
      neutral.container.firstElementChild?.querySelectorAll(
        '[aria-hidden="true"]'
      ).length
    ).toBe(0);
    neutral.unmount();
    // The muted tone's --tone is the inactive grey, so the dot is grey.
    expect(tokensCss).toMatch(
      /\[data-tone='muted'\]\) \{\s*--tone: var\(--gray\);/
    );
  });

  test('filled keeps a status chip a slab: the hue with its own text', () => {
    for (const tone of SEMANTIC) {
      const view = render(
        <Chip tone={tone} filled>
          {tone}
        </Chip>
      );
      const chip = view.container.firstElementChild;
      expect(chip?.getAttribute('data-tone')).toBe(tone);
      expect(chip?.hasAttribute('data-filled')).toBe(true);
      view.unmount();
    }
    // Not a status tone, or not asked: filled changes nothing.
    const plain = render(<Chip filled>Nothing to do</Chip>);
    expect(plain.container.firstElementChild?.hasAttribute('data-filled')).toBe(
      false
    );
    plain.unmount();
    const outline = render(<Chip tone="danger">Failed</Chip>);
    expect(
      outline.container.firstElementChild?.hasAttribute('data-filled')
    ).toBe(false);
    outline.unmount();
    // Filled is Gr8r's tinted badge: the tone's text on its soft tint, no
    // dot and no border.
    const tinted = render(
      <Chip tone="warning" filled>
        Blocked
      </Chip>
    );
    expect(
      tinted.container.firstElementChild?.querySelectorAll(
        '[aria-hidden="true"]'
      ).length
    ).toBe(0);
    tinted.unmount();
    const sheet = css('tasks/chip.module.css');
    expect(rule(sheet, '.accent, .tinted')).toBe(
      'border-color: transparent; background: var(--tone-soft); color: var(--tone-ink);'
    );
  });

  // No chip is a solid slab any more, so a status mark inside keeps its
  // own hue (3:1 or better on every soft tint, styles-contrast.test.ts)
  // and replaces the pill's dot.
  test('a status mark keeps its hue on a tint and replaces the dot', () => {
    const sheet = css('tasks/chip.module.css');
    expect(sheet).not.toMatch(/--(red|amber|green|gray|grey): var\(--on-/);
    const view = render(
      <Chip tone="danger" status="overdue" statusLabel="Overdue">
        Overdue
      </Chip>
    );
    expect(view.getByRole('img', { name: 'Overdue' })).toBeDefined();
    expect(view.container.querySelectorAll('[aria-hidden="true"]').length).toBe(
      0
    );
  });

  test('muted is plain quiet text; inverse the dark slab', () => {
    const sheet = css('tasks/chip.module.css');
    expect(rule(sheet, '.muted')).toContain('background: none;');
    expect(rule(sheet, '.muted')).toContain('color: var(--text-3);');
    expect(rule(sheet, '.inverse')).toContain('background: var(--text);');
  });
});

describe('Notice', () => {
  test('defaults to the accent frame; a status tone is emitted', () => {
    const plain = render(<Notice label="Demo data">Fictional.</Notice>);
    expect(plain.container.firstElementChild?.getAttribute('data-tone')).toBe(
      'accent'
    );
    plain.unmount();
    const failed = render(
      <Notice label="Failed" tone="danger" role="alert">
        Linear refused the write.
      </Notice>
    );
    expect(failed.getByRole('alert').getAttribute('data-tone')).toBe('danger');
  });

  test('a status notice is tinted, its lead-in in the tone from the hook', () => {
    const primitives = css('styles/primitives.css');
    expect(primitives).toContain(
      "[data-tone='warning'], [data-tone='danger'] ) { border-color: transparent; background: var(--tone-soft); }"
    );
    const sheet = css('tasks/notice.module.css');
    expect(rule(sheet, '.key.toneKey')).toBe('color: var(--tone-ink);');
    expect(rule(sheet, ':global(.notice).quiet')).toContain(
      'background: var(--surface)'
    );
  });
});

describe('AlertStrip', () => {
  test('defaults to warning (never the purple) and takes a status tone', () => {
    const plain = render(<AlertStrip label="Note">Hello.</AlertStrip>);
    expect(plain.container.firstElementChild?.getAttribute('data-tone')).toBe(
      'warning'
    );
    plain.unmount();
    const overdue = render(
      <AlertStrip label="Overdue" tone="danger">
        Overdue by 3 days.
      </AlertStrip>
    );
    expect(overdue.container.firstElementChild?.getAttribute('data-tone')).toBe(
      'danger'
    );
  });

  test('tint, icon and lead-in come from the hook; the follow-up link stays purple', () => {
    const sheet = css('shell/alert-strip.module.css');
    expect(rule(sheet, '.strip')).toContain(
      'background: var(--tone-soft, var(--amber-soft))'
    );
    expect(rule(sheet, '.icon')).toContain('color: var(--tone, var(--amber))');
    expect(rule(sheet, '.key')).toContain(
      'color: var(--tone-ink, var(--text))'
    );
    expect(rule(sheet, '.action')).toContain('color: var(--accent-ink)');
    expect(rule(sheet, '.action')).toContain('text-decoration: underline');
  });

  test('TaskDetail passes an alert tone through', () => {
    const view = render(
      <TaskDetail
        taskKey="ENG-12"
        title="Dual-write invoices"
        status={{ kind: 'started', label: 'In Progress' }}
        properties={[]}
        alerts={[
          { label: 'Overdue', tone: 'danger', message: 'Overdue by 3 days.' },
          { label: 'Stalled', tone: 'warning', message: 'In Todo for 9 days.' },
          { label: 'Note', message: 'Default tone.' },
        ]}
      />
    );
    const strips = [...view.container.querySelectorAll('[data-tone]')].filter(
      (el) => /Overdue|Stalled|Note/.test(el.textContent ?? '')
    );
    expect(strips.map((el) => el.getAttribute('data-tone'))).toEqual([
      'danger',
      'warning',
      'warning',
    ]);
  });
});

describe('ProgressRule', () => {
  test('any tone but default paints the fill from the hook; the receipt stays quiet', () => {
    for (const tone of [...SEMANTIC, 'muted', 'accent'] as UiTone[]) {
      const view = render(<ProgressRule done={1} total={2} tone={tone} />);
      expect(view.container.firstElementChild?.getAttribute('data-tone')).toBe(
        tone
      );
      view.unmount();
    }
    const sheet = css('tasks/progress-rule.module.css');
    // Default is Gr8r's accent progress fill.
    expect(rule(sheet, '.fill')).toContain('background: var(--accent)');
    expect(rule(sheet, '.toned .fill')).toBe('background: var(--tone);');
    // One fact is coloured once: the fill says it, the "3/7" stays quiet.
    expect(rule(sheet, '.label')).toContain('color: var(--text-3)');
    expect(sheet).not.toContain('.toned .label');
  });
});

describe('Register', () => {
  test('rows and cells emit their status tone', () => {
    const view = render(
      <Register label="Projects" columns="1fr 1fr">
        <RegisterRow tone="warning">
          <RegisterCell variant="name">Delta exports</RegisterCell>
          <RegisterCell variant="mono" tone="warning">
            Blocked
          </RegisterCell>
        </RegisterRow>
        <RegisterRow tone="danger">
          <RegisterCell variant="name">Run 12</RegisterCell>
          <RegisterCell variant="mono" tone="danger">
            Failed
          </RegisterCell>
        </RegisterRow>
      </Register>
    );
    const rows = view.getAllByRole('listitem');
    expect(rows.map((r) => r.getAttribute('data-tone'))).toEqual([
      'warning',
      'danger',
    ]);
    expect(
      view.getByText('Blocked').parentElement?.getAttribute('data-tone')
    ).toBe('warning');
  });

  test('a toned row draws no rule; the toned text comes from the hook', () => {
    const sheet = css('tasks/register.module.css');
    // Gr8r: a row that needs action says so with a chip or a toned cell.
    expect(sheet).not.toContain('border-left');
    expect(sheet).not.toContain('.rowRule');
    expect(rule(sheet, '.toneText .cellValue')).toBe('color: var(--tone-ink);');
    // The selected row: the accent tint with a 2px accent bar.
    expect(rule(sheet, '.selected')).toBe(
      'background: var(--accent-soft); box-shadow: inset 2px 0 0 var(--accent);'
    );
  });

  test('the line under a toned value stays muted unless the cell opts in', () => {
    const sheet = css('tasks/register.module.css');
    // The sub line is secondary text; the tone colours only the value...
    expect(rule(sheet, '.cellSub')).toContain('color: var(--text-2);');
    expect(sheet).not.toContain('.toneText .cellSub');
    // ...except where the line is the status's reason (toneSub).
    expect(rule(sheet, '.toneSub .cellSub')).toBe('color: var(--tone-ink);');
  });
});

describe('StatsStrip', () => {
  test('a status count is coloured by its tone', () => {
    const view = render(
      <StatsStrip
        cells={[
          { id: 'o', label: 'Overdue milestones', value: 1, tone: 'danger' },
          { id: 'r', label: 'At risk', value: 2, tone: 'warning' },
          { id: 'n', label: 'New to you', value: 3, tone: 'accent' },
        ]}
      />
    );
    expect(
      view.getAllByRole('listitem').map((c) => c.getAttribute('data-tone'))
    ).toEqual(['danger', 'warning', 'accent']);
    const sheet = css('tasks/stats-strip.module.css');
    for (const tone of ['accent', ...SEMANTIC]) {
      expect(sheet).toContain(`.${tone} :where(.value, .note)`);
    }
    expect(sheet).toContain(
      '.info :where(.value, .note) { color: var(--tone-ink); }'
    );
  });
});

describe('Glyphs', () => {
  test('urgent is red, in progress blue, done green', () => {
    const sheet = css('tasks/task-glyphs.module.css');
    expect(rule(sheet, '.urgent')).toBe('color: var(--red);');
    // The workflow colours are --st-* tokens, mapped to the status hues
    // (in progress blue, done green, triage / backlog / canceled grey).
    expect(rule(sheet, '.started')).toBe('color: var(--st-progress);');
    expect(rule(sheet, '.completed')).toBe('color: var(--st-done);');
    for (const [, tokens] of THEMES) {
      expect(hex(tokens, '--st-progress')).toBe(hex(tokens, '--blue'));
      expect(hex(tokens, '--st-done')).toBe(hex(tokens, '--green'));
      for (const grey of ['--st-triage', '--st-backlog', '--st-canceled']) {
        expect([
          grey,
          [
            hex(tokens, '--red'),
            hex(tokens, '--amber'),
            hex(tokens, '--green'),
            hex(tokens, '--blue'),
          ].includes(hex(tokens, grey)),
        ]).toEqual([grey, false]);
      }
    }
    expect(sheet).not.toContain('--accent');
    // Still decorative: the state and priority names say it.
    const view = render(
      <>
        <PriorityGlyph priority={1} />
        <StateGlyph kind="started" />
      </>
    );
    for (const svg of view.container.querySelectorAll('svg')) {
      expect(svg.getAttribute('aria-hidden')).toBe('true');
    }
  });
});

describe('Button', () => {
  test('danger is red at rest and on hover, never purple', () => {
    const sheet = css('tasks/button.module.css');
    // Gr8r's danger button: a red fill with its own text colour.
    expect(rule(sheet, '.danger')).toBe(
      'background: var(--red); color: var(--on-danger);'
    );
    expect(rule(sheet, '.danger:not(:disabled):hover')).toContain(
      'color-mix(in srgb, var(--red) 88%, var(--text))'
    );
    expect(rule(sheet, '.danger')).not.toContain('--accent');
  });
});

describe('Checklist (the rubric)', () => {
  test('met is a filled neutral disc, missing a dashed amber ring and chip', () => {
    const sheet = css('tasks/checklist.module.css');
    // Met stays neutral (as done does), so the one amber item stands out.
    expect(rule(sheet, '.met .mark')).toBe(
      'color: var(--text); background: currentColor;'
    );
    expect(sheet).not.toContain('--green');
    expect(rule(sheet, '.missing .mark')).toBe(
      'color: var(--amber); border-style: dashed;'
    );
    expect(sheet).not.toContain('--accent');
    const view = render(
      <Checklist
        items={[
          { label: 'Target date', met: true },
          { label: 'Lead', met: false },
        ]}
      />
    );
    const missing = view.getByText('Missing').closest('[data-tone]');
    expect(missing?.getAttribute('data-tone')).toBe('warning');
    expect(missing?.hasAttribute('data-filled')).toBe(true);
  });
});

describe('Errors are red (a failed write or load)', () => {
  test('every error key and the error toast use the red hue', () => {
    // --red is text-safe in the Gr8r tokens; --red-ink (its migration
    // alias) is the same colour, so a key may use either. The toast is
    // inverted, so its error icon and timer use --red-ink-inverse.
    const RED = /var\(--red(-ink)?\)/;
    const cases: [string, string, RegExp][] = [
      ['edit/save-status.module.css', '.key', RED],
      ['edit/picker-popover.module.css', '.errorKey', RED],
      ['task/task-comment-list.module.css', '.errorKey', RED],
      ['task/task-description.module.css', '.errorKey', RED],
      ['task/task-relation-list.module.css', '.removeErrorKey', RED],
      ['shell/command-palette.module.css', '.groupError', RED],
      ['shell/toast.module.css', '.error .icon', /var\(--red-ink-inverse\)/],
      ['shell/toast.module.css', '.error .timer', /var\(--red-ink-inverse\)/],
    ];
    for (const [file, selector, token] of cases) {
      expect([file, selector, rule(css(file), selector)]).toEqual([
        file,
        selector,
        expect.stringMatching(token),
      ]);
    }
  });

  test('a toned picker placeholder takes the tone hook', () => {
    expect(
      rule(css('edit/picker-popover.module.css'), '.placeholder.toned')
    ).toBe('color: var(--tone-ink);');
  });
});

describe('A success toast is green (a write that landed)', () => {
  test('its check and countdown take the green inverse step, never the accent', () => {
    const sheet = css('shell/toast.module.css');
    expect(rule(sheet, '.success .icon')).toBe(
      'color: var(--green-ink-inverse);'
    );
    expect(rule(sheet, '.success .timer')).toBe(
      'background: var(--green-ink-inverse);'
    );
    expect(sheet).not.toMatch(/\.success[^{]*\{[^}]*--accent/);
  });
});
