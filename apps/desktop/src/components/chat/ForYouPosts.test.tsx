import type { Message } from '@dispatch/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

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

const CLIENT = 'agent:wsoule679/a2a.dami-long-client-name';

test('a question card offers an answer, with a short button that leaves the input its width', () => {
  renderPosts([post(CLIENT, CLIENT, true, 'question')]);
  fireEvent.click(screen.getByRole('button', { name: 'Answer…' }));
  const input = screen.getByRole('textbox', { name: `Answer ${CLIENT}` });
  expect(input.className).toContain('flex-1');
  expect(input.className).toContain('min-w-0');
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
    expect(alert.className).toContain('break-words');
    expect(
      screen.getByRole<HTMLInputElement>('textbox', {
        name: `Answer ${CLIENT}`,
      }).value
    ).toBe('Ship it tonight');
  },
  UNDO_MS + 4000
);
