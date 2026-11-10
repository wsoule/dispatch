import { Register } from '@dispatch/ui';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Session } from '../../lib/types';
import { SESSION_COLUMNS, SESSION_HEADER, SessionRow } from './SessionRow';

afterEach(cleanup);

const session: Session = {
  id: 's1',
  project_id: 'p1',
  agent: 'claude-code',
  model: null,
  started_at: null,
  ended_at: null,
  last_activity_at: Math.floor(Date.now() / 1000),
  status: 'active',
  duration_seconds: null,
  summary: 'Fix the flaky test',
  title: null,
  prompt_tokens: 1000,
  completion_tokens: 234,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  cost_usd: 0.4,
  lines_added: 0,
  lines_removed: 0,
  tags: null,
  raw_log_path: '/tmp/s1.jsonl',
};

function renderRow(row: Session, onClick: () => void = () => undefined) {
  return render(
    <Register
      label="Sessions"
      columns={SESSION_COLUMNS}
      header={SESSION_HEADER}
    >
      <SessionRow session={row} projectName="dispatch" onClick={onClick} />
    </Register>
  );
}

// The row is one native button named by everything it prints (project and session first,
// then status, model, cost and time, as the old role=button row was read), and it opens the
// detail.
test('the row is a button named by all it prints that opens it', () => {
  let opened = 0;
  renderRow(session, () => {
    opened += 1;
  });
  const button = screen.getByRole('button', {
    name: /^dispatch: Fix the flaky test, Active, unknown model, \$0\.40 · 1\.2k tok, /,
  });
  expect(button.tagName).toBe('BUTTON');
  fireEvent.click(button);
  expect(opened).toBe(1);
});

// The session leads the row: a stacked card is titled by the project (the first cell spans
// the card), not by the bare word "Active". The header follows the same order.
test('the session cell comes first, then the status', () => {
  renderRow(session);
  const cells = screen.getByRole('listitem').children;
  // The stretched button, then the cells.
  expect(cells[1]?.textContent).toContain('dispatch');
  expect(cells[2]?.textContent).toContain('Active');
  expect(SESSION_HEADER.map((column) => column.id)).toEqual([
    'session',
    'status',
    'model',
    'cost',
    'activity',
  ]);
});

// An active session's title shimmers (the old live detail line); an ended one is still.
test('only an active session’s title shimmers', () => {
  renderRow(session);
  expect(
    screen.getByText('Fix the flaky test').hasAttribute('data-shimmer')
  ).toBe(true);
  cleanup();
  renderRow({ ...session, status: 'ended' });
  expect(document.querySelector('[data-shimmer]')).toBeNull();
});

// The status is a word beside a toned dot, so colour is never the only cue: a live session
// is blue (info), an ended one grey (muted).
test('the status says Active or Ended beside a toned dot', () => {
  renderRow(session);
  const active = screen.getByText('Active');
  expect(active.querySelector('[data-tone="info"]')).not.toBeNull();
  cleanup();
  renderRow({ ...session, status: 'ended' });
  const ended = screen.getByText('Ended');
  expect(ended.querySelector('[data-tone="muted"]')).not.toBeNull();
});

// Cost and a compact token count share one cell; an unknown model still names itself.
test('the row shows cost, tokens and the model', () => {
  renderRow(session);
  expect(screen.getByText('$0.40 · 1.2k tok')).toBeDefined();
  expect(screen.getByText('unknown model')).toBeDefined();
});

// A raw model id is long: at 1200px it used to wrap to two lines inside its chip. It now
// stays on one line and ends in an ellipsis, the chip's title holding the full id, and the
// row's name still carries it whole.
test('the model chip keeps a raw id on one line, with the full id as its title', () => {
  renderRow({ ...session, model: 'claude-sonnet-4-5-experimental-build' });
  const name = screen.getByText('claude-sonnet-4-5-experimental-build');
  const chip = name.closest('[data-tone]');
  expect(chip?.getAttribute('title')).toBe(
    'claude-sonnet-4-5-experimental-build'
  );
  expect(
    screen.getByRole('button', {
      name: /, claude-sonnet-4-5-experimental-build, /,
    })
  ).toBeDefined();
  const css = readFileSync(
    join(import.meta.dir, 'sessions.module.css'),
    'utf8'
  ).replace(/\/\*[\s\S]*?\*\//g, '');
  const at = css.indexOf('\n.model {');
  expect(at).toBeGreaterThan(-1);
  const rule = css.slice(at, css.indexOf('}', at));
  for (const declaration of [
    'overflow: hidden;',
    'text-overflow: ellipsis;',
    'white-space: nowrap;',
  ]) {
    expect(rule).toContain(declaration);
  }
});

// No id to show in full: an unknown model's chip carries no title.
test('an unknown model chip has no title', () => {
  renderRow(session);
  expect(
    screen
      .getByText('unknown model')
      .closest('[data-tone]')
      ?.hasAttribute('title')
  ).toBe(false);
});
