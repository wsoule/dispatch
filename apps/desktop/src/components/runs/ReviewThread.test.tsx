import { ApiError } from '@dispatch/client';
import type { ReviewComment } from '@dispatch/client';
import { EditProvider } from '@pierre/diffs/react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'bun:test';

import { ReviewComposer, ReviewThread } from './ReviewThread';
import { createReviewEditor } from '@/lib/pierreEditor';

// Minimal but type-complete `ReviewComment` — only the fields a given test cares about vary.
function comment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: 'c1',
    file: 'a.ts',
    line: 2,
    pending: true,
    anchorText: 'const b = 1;',
    author: 'wyat',
    body: 'nit',
    resolved: false,
    created: '2026-08-04T00:00:00.000Z',
    replies: [],
    ...overrides,
  };
}

describe('ReviewThread — the Apply affordance', () => {
  it('renders no Apply button when the comment has no suggestion', () => {
    render(
      <ReviewThread
        comment={comment()}
        anchor="exact"
        onResolve={() => {}}
        onReply={() => {}}
        onApply={() => Promise.resolve()}
      />
    );
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull();
  });

  it('renders no Apply button when there is nowhere to apply into, even with a suggestion', () => {
    render(
      <ReviewThread
        comment={comment({ suggestion: 'const b = 2;' })}
        anchor="exact"
        onResolve={() => {}}
        onReply={() => {}}
      />
    );
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull();
  });

  it('calls onApply when a suggestion is present and the button is clicked', async () => {
    let applied = false;
    render(
      <ReviewThread
        comment={comment({ suggestion: 'const b = 2;' })}
        anchor="exact"
        onResolve={() => {}}
        onReply={() => {}}
        onApply={() => {
          applied = true;
          return Promise.resolve();
        }}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(applied).toBe(true));
  });

  it('disables the button and shows why on a 409 anchor-drifted failure', async () => {
    render(
      <ReviewThread
        comment={comment({ suggestion: 'const b = 2;' })}
        anchor="exact"
        onResolve={() => {}}
        onReply={() => {}}
        onApply={() => Promise.reject(new ApiError('anchor-drifted', 409))}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(
        screen.getByText(
          'The code here has changed since this suggestion was written, so it can no longer be applied by line number.'
        )
      ).toBeDefined()
    );
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Apply' }).disabled
    ).toBe(true);
  });

  it('shows the reason but leaves the button clickable on a transient failure', async () => {
    render(
      <ReviewThread
        comment={comment({ suggestion: 'const b = 2;' })}
        anchor="exact"
        onResolve={() => {}}
        onReply={() => {}}
        onApply={() => Promise.reject(new ApiError('worktree-busy', 409))}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(
        screen.getByText(
          'An agent is working in this worktree — wait for it to finish, then try again.'
        )
      ).toBeDefined()
    );
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Apply' }).disabled
    ).toBe(false);
  });
});

describe('ReviewThread — the existing thread behaviour', () => {
  it('still shows the resolve toggle and calls onResolve', () => {
    let resolved: boolean | undefined;
    render(
      <ReviewThread
        comment={comment()}
        anchor="exact"
        onResolve={(r) => {
          resolved = r;
        }}
        onReply={() => {}}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'resolve' }));
    expect(resolved).toBe(true);
  });

  it('still sends a reply on Enter', () => {
    let replyBody: string | undefined;
    render(
      <ReviewThread
        comment={comment()}
        anchor="exact"
        onResolve={() => {}}
        onReply={(body) => {
          replyBody = body;
        }}
      />
    );
    const input = screen.getByPlaceholderText(
      'Reply — the agent reads this when you send the work back'
    );
    fireEvent.change(input, { target: { value: 'looks right to me' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(replyBody).toBe('looks right to me');
  });
});

// `ReviewComposer` nests a real Pierre `CodeView` for the suggestion editor, so every render
// test wraps it in `EditProvider` the same way `PierreReviewDiff` does in production.
function renderComposer(
  props: Partial<Parameters<typeof ReviewComposer>[0]> = {}
) {
  const onSubmit = props.onSubmit ?? (() => {});
  const onCancel = props.onCancel ?? (() => {});
  return render(
    <EditProvider createEditor={createReviewEditor}>
      <ReviewComposer
        line={2}
        file="a.ts"
        fileContents={null}
        onSubmit={onSubmit}
        onCancel={onCancel}
        {...props}
      />
    </EditProvider>
  );
}

describe('ReviewComposer — the suggestion editor', () => {
  it('withholds the suggestion editor until file contents resolve', () => {
    renderComposer({ fileContents: null });
    expect(screen.queryByTestId('suggestion-editor')).toBeNull();
  });

  it('mounts the suggestion editor once file contents are in hand', () => {
    renderComposer({ fileContents: 'a\nb\nc\n' });
    expect(screen.queryByTestId('suggestion-editor')).not.toBeNull();
  });

  it('submits with no suggestion when the editor is never touched (still equals the seed)', () => {
    let submitted: { body: string; suggestion: string | undefined } | null =
      null;
    renderComposer({
      fileContents: 'a\nb\nc\n',
      onSubmit: (body, suggestion) => {
        submitted = { body, suggestion };
      },
    });
    fireEvent.change(
      screen.getByPlaceholderText(
        'What should change? This goes back with the work.'
      ),
      { target: { value: 'nit: rename this' } }
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }));
    expect(submitted).toEqual({
      body: 'nit: rename this',
      suggestion: undefined,
    });
  });

  it('does not submit an empty comment', () => {
    let calls = 0;
    renderComposer({
      onSubmit: () => {
        calls += 1;
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }));
    expect(calls).toBe(0);
  });

  it('cancels on Escape', () => {
    let cancelled = false;
    renderComposer({
      onCancel: () => {
        cancelled = true;
      },
    });
    fireEvent.keyDown(
      screen.getByPlaceholderText(
        'What should change? This goes back with the work.'
      ),
      { key: 'Escape' }
    );
    expect(cancelled).toBe(true);
  });

  it('shows the range in its header when a startLine is given', () => {
    renderComposer({ startLine: 4, line: 7 });
    expect(screen.getByText('Comment on lines 4–7')).toBeDefined();
  });
});
