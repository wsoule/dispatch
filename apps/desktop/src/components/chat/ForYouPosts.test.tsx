import type { Message } from '@dispatch/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Post } from '../../lib/posts';
import { UNDO_MS } from '../conversation/HomeComposer';
import { ForYouPosts } from './ForYouPosts';

function post(
  key: string,
  from: string,
  unread: boolean,
  kind = 'message'
): Post {
  const latest: Message = {
    id: `m-${key}`,
    thread: key,
    replyTo: null,
    from,
    to: ['human:me'],
    kind,
    body: `About ${key}`,
    refs: [],
    urgent: false,
    blocking: false,
    wake: 'none',
    createdAt: '2026-10-26T19:17:00Z',
  };
  return {
    key,
    subject: key,
    kind: 'for-you',
    latest,
    count: 1,
    unread,
    deliveries: [],
  };
}

// Runs resolve to their task title, as App's addressName does.
const label = (address: string) =>
  address === 'run:r-1' ? 'Ship the thing' : address.replace(/^human:/, '');

function renderPosts(
  posts: Post[],
  handlers: {
    onDismiss?: (post: Post) => void;
    onClearAll?: (posts: readonly Post[]) => void;
    onReply?: (post: Post, body: string) => Promise<void>;
  } = {}
) {
  return render(
    <ForYouPosts
      posts={posts}
      label={label}
      onOpen={() => {}}
      onReply={handlers.onReply ?? (async () => {})}
      onDismiss={handlers.onDismiss ?? (() => {})}
      onClearAll={handlers.onClearAll ?? (() => {})}
      holding={false}
    />
  );
}

test('a run posting about itself reads as its task title, once', () => {
  renderPosts([post('run:r-1', 'run:r-1', false)]);
  const row = screen.getByTestId('for-you-post-read');
  expect(row.textContent).toContain('Ship the thing');
  expect(row.textContent).not.toContain('r-1');
  expect(row.textContent).not.toContain(' on ');
});

test('read and unread posts each dismiss on their own', () => {
  const dismissed: string[] = [];
  renderPosts(
    [post('run:r-1', 'run:r-1', false), post('task:t-2', 'human:ana', true)],
    { onDismiss: (p) => dismissed.push(p.key) }
  );
  const buttons = screen.getAllByTestId('for-you-post-dismiss');
  expect(buttons).toHaveLength(2);
  fireEvent.click(buttons[0]);
  fireEvent.click(buttons[1]);
  expect(dismissed).toEqual(['run:r-1', 'task:t-2']);
});

test('Clear all hands over every post showing', () => {
  let cleared: readonly Post[] = [];
  renderPosts(
    [post('run:r-1', 'run:r-1', false), post('task:t-2', 'human:ana', true)],
    { onClearAll: (p) => (cleared = p) }
  );
  fireEvent.click(screen.getByTestId('for-you-clear-all'));
  expect(cleared.map((p) => p.key)).toEqual(['run:r-1', 'task:t-2']);
});

// bun loads a CSS module as an empty map (every class undefined), so a rendered
// class proves nothing about the module: these read the component's source and
// the sheet instead, to check that the class is put on the element and what the
// sheet's rule for it holds.
const source = readFileSync(join(import.meta.dir, 'ForYouPosts.tsx'), 'utf8');
const sheet = readFileSync(join(import.meta.dir, 'posts.module.css'), 'utf8');

// The declarations of `.name { … }` in posts.module.css, or '' when it has none.
function rule(name: string): string {
  const match = new RegExp(`\\.${name} \\{([^}]*)\\}`).exec(sheet);
  return match?.[1] ?? '';
}

const CLIENT = 'agent:wsoule679/a2a.dami-long-client-name';

test('a question card offers an answer, with a short button that leaves the input its width', () => {
  renderPosts([post(CLIENT, CLIENT, true, 'question')]);
  fireEvent.click(screen.getByRole('button', { name: 'Answer…' }));
  const input = screen.getByRole('textbox', { name: `Answer ${CLIENT}` });
  // The field takes the row's width: its module class grows and may shrink.
  expect(input.className).toContain('input');
  expect(source).toMatch(/<TextField\b[^<]*className=\{styles\.replyInput\}/);
  expect(rule('replyInput')).toContain('flex: 1;');
  expect(rule('replyInput')).toContain('min-width: 0;');
  const send = screen.getByRole('button', { name: `Answer ${CLIENT}` });
  expect(send.textContent).toBe('Answer');
});

test(
  'a failed reply comes back into the input with a visible error',
  async () => {
    renderPosts([post(CLIENT, CLIENT, true, 'question')], {
      onReply: () => Promise.reject(new Error('A2A client is offline')),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Answer…' }));
    const input = screen.getByRole('textbox', { name: `Answer ${CLIENT}` });
    fireEvent.change(input, { target: { value: 'Ship it tonight' } });
    fireEvent.click(screen.getByRole('button', { name: `Answer ${CLIENT}` }));
    const alert = await screen.findByRole(
      'alert',
      {},
      { timeout: UNDO_MS + 2000 }
    );
    expect(alert.textContent?.length ?? 0).toBeGreaterThan(0);
    // A long reason wraps anywhere and stays on screen, in the danger tone.
    expect(alert.className).toContain('toneText');
    expect(alert.getAttribute('data-tone')).toBe('danger');
    expect(source).toMatch(
      /role="alert"\s+className=\{cx\('toneText', styles\.error\)\}/
    );
    expect(rule('error')).toContain('overflow-wrap: anywhere;');
    expect(rule('error')).toContain('white-space: normal;');
    expect(
      screen.getByRole<HTMLInputElement>('textbox', {
        name: `Answer ${CLIENT}`,
      }).value
    ).toBe('Ship it tonight');
  },
  UNDO_MS + 4000
);

test('an unread post is an article in the feed; a read one is a single line', () => {
  renderPosts([
    post('run:r-1', 'run:r-1', false),
    post('task:t-2', 'human:ana', true),
  ]);
  const cards = screen.getAllByRole('article');
  expect(cards).toHaveLength(1);
  expect(cards[0].getAttribute('data-testid')).toBe('for-you-post');
  expect(screen.getByTestId('for-you-post-read').closest('article')).toBeNull();
});

test('the card names its sender and subject once each, cut to one line', () => {
  renderPosts([
    post('task:t-2', 'human:ana', true),
    post(CLIENT, CLIENT, true),
  ]);
  // Sender and subject differ: the subject is a chip whose full words are its title.
  const subject = screen.getByText('t-2');
  expect(subject.closest('[title="t-2"]')).not.toBeNull();
  // A sender writing about itself reads once: no chip repeating the sender.
  expect(screen.getAllByText(CLIENT)).toHaveLength(1);
  // The sender and the subject give way before the time and the dismiss
  // control: both cut to one line with an ellipsis, and the chip is free to
  // shrink below its words rather than wrapping them a letter a line.
  expect(rule('from')).toContain('min-width: 0;');
  for (const name of ['from', 'subjectText']) {
    expect(rule(name)).toContain('overflow: hidden;');
    expect(rule(name)).toContain('text-overflow: ellipsis;');
    expect(rule(name)).toContain('white-space: nowrap;');
  }
  expect(rule('subject')).toContain('min-width: 0;');
  expect(sheet).toMatch(/\.subject > span \{\s*min-width: 0;\s*\}/);
  expect(source).toMatch(
    /<Chip title=\{subject\}>\s*<span className=\{styles\.subjectText\}>/
  );
});

test('the dismiss control keeps its size in the card and in the read row', () => {
  renderPosts([
    post('run:r-1', 'run:r-1', false),
    post('task:t-2', 'human:ana', true),
  ]);
  expect(screen.getAllByTestId('for-you-post-dismiss')).toHaveLength(2);
  // One dismiss element serves both layouts, and it never shrinks.
  expect(source).toMatch(
    /data-testid="for-you-post-dismiss"[^/]*className=\{styles\.rowAction\}/
  );
  expect(rule('rowAction')).toContain('flex: none;');
});

test('during an agent turn, Dismiss and Clear all still take posts away at once', () => {
  const a = post('task:t-2', 'human:ana', true);
  const b = post('task:t-3', 'human:bo', true);
  const c = post('task:t-4', 'human:cy', true);
  let showing = [a, b, c];
  const view = (posts: Post[]) => (
    <ForYouPosts
      posts={posts}
      label={label}
      onOpen={() => {}}
      onReply={async () => {}}
      // The app drops a dismissed post from what it passes, as App's dismissForYou does.
      onDismiss={(p) => (showing = showing.filter((x) => x.key !== p.key))}
      onClearAll={(ps) =>
        (showing = showing.filter((x) => !ps.some((p) => p.key === x.key)))
      }
      holding
    />
  );
  const { rerender } = render(view(showing));
  fireEvent.click(screen.getAllByTestId('for-you-post-dismiss')[0]);
  rerender(view(showing));
  expect(screen.getAllByTestId('for-you-post')).toHaveLength(2);
  // Holding still keeps a new post behind "1 new" rather than in the stream.
  expect(screen.queryByRole('button', { name: '1 new' })).toBeNull();
  fireEvent.click(screen.getByTestId('for-you-clear-all'));
  rerender(view(showing));
  expect(screen.queryByTestId('for-you')).toBeNull();
  rerender(view([post('task:t-5', 'human:di', true)]));
  expect(screen.getByRole('button', { name: '1 new' })).toBeTruthy();
});
