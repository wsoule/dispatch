import { Register } from '@dispatch/ui';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'bun:test';

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
