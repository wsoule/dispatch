import type { ReviewComment } from '@dispatch/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';

import { ReviewComposer, ReviewThread } from './ReviewThread';

function comment(over: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: 'c1',
    file: 'src/a.ts',
    line: 10,
    pending: false,
    anchorText: '',
    author: 'wsoule',
    body: 'This needs a guard.',
    resolved: false,
    created: '2026-08-04T00:00:00.000Z',
    replies: [],
    ...over,
  };
}

// A comment GitHub already knows about, both ids read back — the only state
// in which the reply box and the resolve button are offered on a PR.
function onGitHub(over: Partial<ReviewComment> = {}): ReviewComment {
  return comment({ githubId: 555, githubThreadId: 'PRRT_1', ...over });
}

const ok = () => Promise.resolve();
const boom = () =>
  Promise.reject(new Error('comment has not been pushed to GitHub yet: c1'));

describe('ReviewThread', () => {
  // A staged PR draft has no GitHub comment id and no review thread, so both
  // server calls 409 by construction. Offering the controls anyway is how a
  // typed reply used to be swallowed.
  test('a staged GitHub draft offers neither reply nor resolve', () => {
    render(
      <ReviewThread
        comment={comment({ pending: true })}
        anchor="exact"
        destination="github"
        onResolve={ok}
        onReply={ok}
      />
    );

    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /resolve/i })).toBeNull();
    expect(screen.getByText(/reaches github when you submit/i)).toBeDefined();
  });

  test('a published GitHub comment keeps both controls', () => {
    render(
      <ReviewThread
        comment={onGitHub()}
        anchor="exact"
        destination="github"
        onResolve={ok}
        onReply={ok}
      />
    );

    expect(screen.getByPlaceholderText(/posts to this thread/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /resolve/i })).toBeDefined();
  });

  // Review finding: `pending` was standing in for "on GitHub". A comment
  // that has been pushed but whose ids were never read back (a failed or
  // truncated thread sync) is not pending, so both controls were offered
  // and both 409ed. They gate on the ids themselves now.
  test('a pushed comment with no ids read back yet offers neither control', () => {
    render(
      <ReviewThread
        comment={comment({ pending: false })}
        anchor="exact"
        destination="github"
        onResolve={ok}
        onReply={ok}
      />
    );

    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /resolve/i })).toBeNull();
    expect(screen.getByText(/not linked to its github thread/i)).toBeDefined();
  });

  // The two ids gate different verbs, so a comment GitHub knows about but
  // whose thread node is unknown can still be replied to.
  test('a comment with an id but no thread id can reply, not resolve', () => {
    render(
      <ReviewThread
        comment={comment({ pending: false, githubId: 555 })}
        anchor="exact"
        destination="github"
        onResolve={ok}
        onReply={ok}
      />
    );

    expect(screen.getByPlaceholderText(/posts to this thread/i)).toBeDefined();
    expect(screen.queryByRole('button', { name: /resolve/i })).toBeNull();
  });

  // The run path stages every comment the same way, but its store takes both
  // verbs locally, so `pending` must not gate anything there.
  test('a pending run draft is untouched — both controls stay', () => {
    render(
      <ReviewThread
        comment={comment({ pending: true })}
        anchor="exact"
        onResolve={ok}
        onReply={ok}
      />
    );

    expect(screen.getByPlaceholderText(/the agent reads this/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /resolve/i })).toBeDefined();
  });

  test('a failed reply keeps the text and says what went wrong', async () => {
    render(
      <ReviewThread
        comment={onGitHub()}
        anchor="exact"
        destination="github"
        onResolve={ok}
        onReply={boom}
      />
    );

    const input = screen.getByRole<HTMLInputElement>('textbox');
    fireEvent.change(input, { target: { value: 'Still broken on retry.' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());
    expect(screen.getByRole('alert').textContent).toContain(
      'has not been pushed to GitHub yet'
    );
    expect(screen.getByRole<HTMLInputElement>('textbox').value).toBe(
      'Still broken on retry.'
    );
  });

  test('a sent reply clears the box', async () => {
    render(
      <ReviewThread
        comment={onGitHub()}
        anchor="exact"
        destination="github"
        onResolve={ok}
        onReply={ok}
      />
    );

    const input = screen.getByRole<HTMLInputElement>('textbox');
    fireEvent.change(input, { target: { value: 'Agreed.' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(screen.getByRole<HTMLInputElement>('textbox').value).toBe('')
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('a failed resolve is reported rather than dropped', async () => {
    render(
      <ReviewThread
        comment={onGitHub()}
        anchor="exact"
        destination="github"
        onResolve={boom}
        onReply={ok}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /resolve/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());
  });
});

describe('ReviewComposer', () => {
  // The composer used to close on submit regardless of what the write did,
  // so a rejected POST discarded the note with no trace of it anywhere.
  test('a failed submit keeps the composed note on screen', async () => {
    let closed = false;
    render(
      <ReviewComposer
        line={10}
        destination="github"
        onCancel={() => {
          closed = true;
        }}
        onSubmit={boom}
      />
    );

    const box = screen.getByRole<HTMLTextAreaElement>('textbox');
    fireEvent.change(box, { target: { value: 'Guard this branch.' } });
    fireEvent.click(screen.getByRole('button', { name: /add comment/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());
    expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe(
      'Guard this branch.'
    );
    expect(closed).toBe(false);
  });

  test('a successful submit hands the trimmed body up once', async () => {
    const bodies: string[] = [];
    render(
      <ReviewComposer
        line={10}
        destination="github"
        onCancel={() => {}}
        onSubmit={(body) => {
          bodies.push(body);
          return Promise.resolve();
        }}
      />
    );

    const box = screen.getByRole<HTMLTextAreaElement>('textbox');
    fireEvent.change(box, { target: { value: '  Guard this branch.  ' } });
    fireEvent.click(screen.getByRole('button', { name: /add comment/i }));

    await waitFor(() => expect(bodies).toEqual(['Guard this branch.']));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
