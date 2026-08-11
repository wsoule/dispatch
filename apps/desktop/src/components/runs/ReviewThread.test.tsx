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
        onResolve={() => Promise.resolve()}
        onReply={() => Promise.resolve()}
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
        onResolve={() => Promise.resolve()}
        onReply={() => Promise.resolve()}
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
        onResolve={() => Promise.resolve()}
        onReply={() => Promise.resolve()}
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
        onResolve={() => Promise.resolve()}
        onReply={() => Promise.resolve()}
        onApply={() => Promise.reject(new ApiError('anchor-drifted', 409))}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(
        screen.getByText(
          "The code changed since this suggestion. It can't be applied anymore."
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
        onResolve={() => Promise.resolve()}
        onReply={() => Promise.resolve()}
        onApply={() => Promise.reject(new ApiError('worktree-busy', 409))}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(
        screen.getByText('An agent is working here. Wait for it to finish.')
      ).toBeDefined()
    );
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Apply' }).disabled
    ).toBe(false);
  });
});

describe('ReviewThread — seeding Apply state from a failed `Apply now`', () => {
  // `Apply now` in the composer can fail its apply step after the comment was already saved
  // (see `submitAndApplyNow` in suggestionRange.ts). `PierreReviewDiff` reports that failure
  // here so the newly rendered thread shows the exact same message/disable state the reviewer
  // would have gotten by clicking this same Apply button themselves — the composer is already
  // gone by the time the failure is known, so this thread is the only place left to show it.
  it('shows the same disabled+message state a live anchor-drifted failure would', () => {
    render(
      <ReviewThread
        comment={comment({ suggestion: 'const b = 2;' })}
        anchor="exact"
        onResolve={() => Promise.resolve()}
        onReply={() => Promise.resolve()}
        onApply={() => Promise.resolve()}
        initialApplyError={{
          message: 'The code here has changed…',
          disable: true,
        }}
      />
    );
    expect(screen.getByText('The code here has changed…')).toBeDefined();
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Apply' }).disabled
    ).toBe(true);
  });

  it('leaves the button clickable when the seeded failure was not anchor-drifted', () => {
    render(
      <ReviewThread
        comment={comment({ suggestion: 'const b = 2;' })}
        anchor="exact"
        onResolve={() => Promise.resolve()}
        onReply={() => Promise.resolve()}
        onApply={() => Promise.resolve()}
        initialApplyError={{
          message: 'An agent is working in this worktree…',
          disable: false,
        }}
      />
    );
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Apply' }).disabled
    ).toBe(false);
  });

  it('starts idle (no seeded failure) when nothing was reported', () => {
    render(
      <ReviewThread
        comment={comment({ suggestion: 'const b = 2;' })}
        anchor="exact"
        onResolve={() => Promise.resolve()}
        onReply={() => Promise.resolve()}
        onApply={() => Promise.resolve()}
      />
    );
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Apply' }).disabled
    ).toBe(false);
    expect(screen.queryByText(/agent is working/)).toBeNull();
  });

  // The real bug this covers: `Apply now`'s apply step is a POST that does a file write and a
  // git commit, racing a plain GET refetch of the comment list that the save's own
  // `invalidateReview()` kicks off first. That refetch very plausibly wins, so this thread
  // mounts (with no failure yet known) BEFORE `onApplyNowFailed` ever reports one — the failure
  // arrives as a *prop change* on an already-mounted thread, not as its initial value. A
  // `useState` lazy initializer only runs once, at mount, so relying on it alone would silently
  // drop that failure — a rejected apply that could never be discovered from the UI.
  it('picks up a failure that arrives after mount, not just at initial render', () => {
    const props = {
      comment: comment({ suggestion: 'const b = 2;' }),
      anchor: 'exact' as const,
      onResolve: () => Promise.resolve(),
      onReply: () => Promise.resolve(),
      onApply: () => Promise.resolve(),
    };
    const { rerender } = render(<ReviewThread {...props} />);
    expect(screen.queryByText(/agent is working/)).toBeNull();

    rerender(
      <ReviewThread
        {...props}
        initialApplyError={{
          message: 'An agent is working in this worktree…',
          disable: true,
        }}
      />
    );

    expect(
      screen.getByText('An agent is working in this worktree…')
    ).toBeDefined();
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Apply' }).disabled
    ).toBe(true);
  });

  // The double-apply race this covers: a comment created via `Apply now` mounts before its own
  // `Apply now` apply attempt has settled (see the test above), so its Apply button starts
  // enabled and clickable. If the reviewer clicks it themselves and THAT click succeeds before
  // the original `Apply now` failure ever reaches `onApplyNowFailed`, the late failure must not
  // overwrite a success that already landed — the suggestion really was applied, and saying
  // otherwise would be exactly the kind of lie this task exists to prevent.
  it('does not let a late stale failure overwrite an already-successful apply', async () => {
    const props = {
      comment: comment({ suggestion: 'const b = 2;' }),
      anchor: 'exact' as const,
      onResolve: () => Promise.resolve(),
      onReply: () => Promise.resolve(),
      onApply: () => Promise.resolve(),
    };
    const { rerender } = render(<ReviewThread {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    // The button reads "Applied" once the click's own apply resolves — waiting on that
    // means the success has actually landed in state before the late failure arrives below.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Applied' })).not.toBeNull()
    );

    rerender(
      <ReviewThread
        {...props}
        initialApplyError={{
          message: 'The code here has changed…',
          disable: true,
        }}
      />
    );

    expect(screen.queryByText('The code here has changed…')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Applied' })).not.toBeNull();
  });
});

describe('ReviewThread — a landed apply says so', () => {
  // A second click after a successful apply used to come back as 409
  // anchor-drifted ("the code here has changed"), because the suggestion had
  // already replaced the anchored line — a confusing way to learn the first
  // click worked. The button reports the outcome instead of inviting a retry.
  it('shows a disabled Applied button once the apply resolves', async () => {
    render(
      <ReviewThread
        comment={comment({ suggestion: 'const b = 2;' })}
        anchor="exact"
        onResolve={() => Promise.resolve()}
        onReply={() => Promise.resolve()}
        onApply={() => Promise.resolve()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() =>
      expect(
        screen.getByRole<HTMLButtonElement>('button', { name: 'Applied' })
          .disabled
      ).toBe(true)
    );
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull();
  });

  it('does not fire a second apply after one has landed', async () => {
    let calls = 0;
    render(
      <ReviewThread
        comment={comment({ suggestion: 'const b = 2;' })}
        anchor="exact"
        onResolve={() => Promise.resolve()}
        onReply={() => Promise.resolve()}
        onApply={() => {
          calls += 1;
          return Promise.resolve();
        }}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Applied' })).not.toBeNull()
    );

    fireEvent.click(screen.getByRole('button', { name: 'Applied' }));

    expect(calls).toBe(1);
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
          return Promise.resolve();
        }}
        onReply={() => Promise.resolve()}
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
        onResolve={() => Promise.resolve()}
        onReply={(body) => {
          replyBody = body;
          return Promise.resolve();
        }}
      />
    );
    const input = screen.getByPlaceholderText(
      'Reply. The agent reads this when you send the work back.'
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
  const onSubmit = props.onSubmit ?? (() => Promise.resolve(comment()));
  const onCancel = props.onCancel ?? (() => {});
  const onSaved = props.onSaved ?? (() => {});
  return render(
    <EditProvider createEditor={createReviewEditor}>
      <ReviewComposer
        line={2}
        file="a.ts"
        fileContents={null}
        onSubmit={onSubmit}
        onCancel={onCancel}
        onSaved={onSaved}
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
        return Promise.resolve(comment());
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
        return Promise.resolve(comment());
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

  it('calls onSaved once the save resolves, closing the composer', async () => {
    let saved = false;
    renderComposer({
      onSubmit: () => Promise.resolve(comment()),
      onSaved: () => {
        saved = true;
      },
    });
    fireEvent.change(
      screen.getByPlaceholderText(
        'What should change? This goes back with the work.'
      ),
      { target: { value: 'looks good' } }
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }));
    // Waits for `busy` to clear too (the `finally` after the resolved save), so no state
    // update from this click is still pending once the test ends.
    await waitFor(() =>
      expect(
        screen.getByRole<HTMLButtonElement>('button', { name: 'Add comment' })
          .disabled
      ).toBe(false)
    );
    expect(saved).toBe(true);
  });

  it('does not call onSaved when the save itself fails — the draft stays put', async () => {
    let saved = false;
    let rejected = false;
    renderComposer({
      onSubmit: () => {
        rejected = true;
        return Promise.reject(new Error('network down'));
      },
      onSaved: () => {
        saved = true;
      },
    });
    fireEvent.change(
      screen.getByPlaceholderText(
        'What should change? This goes back with the work.'
      ),
      { target: { value: 'looks good' } }
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }));
    // Waits for the button's own `busy` state to clear (the `finally` after the rejection),
    // rather than just `rejected`, so no state update from this click is still pending once
    // the assertion below runs.
    await waitFor(() =>
      expect(
        screen.getByRole<HTMLButtonElement>('button', { name: 'Add comment' })
          .disabled
      ).toBe(false)
    );
    expect(rejected).toBe(true);
    expect(saved).toBe(false);
  });
});

describe('ReviewComposer — the anchor it records', () => {
  // Without a real anchor every human suggestion is permanently un-appliable:
  // `resolveAnchor` calls an empty `anchorText` outdated, so apply answers 409
  // anchor-drifted and the thread claims the code changed when it never did.
  // Captured here, from the same `fileContents` the suggestion editor seeds
  // from, so the two can never describe different text.
  it('records the commented line’s own text as the anchor', () => {
    let submitted: string | null = null;
    renderComposer({
      line: 2,
      fileContents: 'const a = 0;\nconst b = 1;\nconst c = 2;\n',
      onSubmit: (_body, _suggestion, anchorText) => {
        submitted = anchorText;
        return Promise.resolve(comment());
      },
    });
    fireEvent.change(
      screen.getByPlaceholderText(
        'What should change? This goes back with the work.'
      ),
      { target: { value: 'nit' } }
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }));
    expect(submitted).toBe('const b = 1;');
  });

  it('anchors a range comment to its LAST line, which is what resolveAnchor checks', () => {
    let submitted: string | null = null;
    renderComposer({
      startLine: 1,
      line: 3,
      fileContents: 'const a = 0;\nconst b = 1;\nconst c = 2;\n',
      onSubmit: (_body, _suggestion, anchorText) => {
        submitted = anchorText;
        return Promise.resolve(comment());
      },
    });
    fireEvent.change(
      screen.getByPlaceholderText(
        'What should change? This goes back with the work.'
      ),
      { target: { value: 'nit' } }
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }));
    expect(submitted).toBe('const c = 2;');
  });

  it('records an empty anchor only when there are no contents to read one from', () => {
    let submitted: string | null = null;
    renderComposer({
      fileContents: null,
      onSubmit: (_body, _suggestion, anchorText) => {
        submitted = anchorText;
        return Promise.resolve(comment());
      },
    });
    fireEvent.change(
      screen.getByPlaceholderText(
        'What should change? This goes back with the work.'
      ),
      { target: { value: 'nit' } }
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }));
    // No contents means no suggestion editor either, so this can only ever be
    // a prose comment — there is nothing appliable to leave un-anchored.
    expect(submitted).toBe('');
  });
});

describe('ReviewComposer — `Apply now`', () => {
  // Pierre's real suggestion editor cannot be driven under `bun test` (see
  // `submitAndApplyNow`'s doc comment in suggestionRange.ts — its text measurement needs a
  // canvas context happy-dom does not implement), so these only cover the reachable state:
  // an untouched editor, where the suggestion is by definition still equal to its seed. The
  // save-then-apply orchestration itself (id threading, ordering, and the no-rollback-on-
  // failure guarantee) is pinned directly in suggestionRange.test.ts's `submitAndApplyNow`
  // tests instead.
  it('offers no Apply now button when the suggestion still matches its seed', () => {
    renderComposer({
      fileContents: 'a\nb\nc\n',
      onApply: () => Promise.resolve(),
    });
    expect(screen.queryByRole('button', { name: 'Apply now' })).toBeNull();
  });

  it('offers no Apply now button when there is nowhere to apply into', () => {
    renderComposer({ fileContents: 'a\nb\nc\n' });
    expect(screen.queryByRole('button', { name: 'Apply now' })).toBeNull();
  });
});

// A comment GitHub already knows about, both ids read back — the only state
// in which the reply box and the resolve button are offered on a PR.
function onGitHub(over: Partial<ReviewComment> = {}): ReviewComment {
  return comment({
    pending: false,
    githubId: 555,
    githubThreadId: 'PRRT_1',
    ...over,
  });
}

const ok = () => Promise.resolve();
const boom = () =>
  Promise.reject(new Error('comment has not been pushed to GitHub yet: c1'));

describe('ReviewThread — the GitHub destination', () => {
  // A staged PR draft has no GitHub comment id and no review thread, so both
  // server calls 409 by construction. Offering the controls anyway is how a
  // typed reply used to be swallowed.
  it('a staged GitHub draft offers neither reply nor resolve', () => {
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

  it('a published GitHub comment keeps both controls', () => {
    render(
      <ReviewThread
        comment={onGitHub()}
        anchor="exact"
        destination="github"
        onResolve={ok}
        onReply={ok}
      />
    );

    expect(screen.getByPlaceholderText(/posts to github/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /resolve/i })).toBeDefined();
  });

  // Review finding: `pending` was standing in for "on GitHub". A comment
  // that has been pushed but whose ids were never read back (a failed or
  // truncated thread sync) is not pending, so both controls were offered
  // and both 409ed. They gate on the ids themselves now.
  it('a pushed comment with no ids read back yet offers neither control', () => {
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
    expect(screen.getByText(/not linked to github/i)).toBeDefined();
  });

  // The two ids gate different verbs, so a comment GitHub knows about but
  // whose thread node is unknown can still be replied to.
  it('a comment with an id but no thread id can reply, not resolve', () => {
    render(
      <ReviewThread
        comment={comment({ pending: false, githubId: 555 })}
        anchor="exact"
        destination="github"
        onResolve={ok}
        onReply={ok}
      />
    );

    expect(screen.getByPlaceholderText(/posts to github/i)).toBeDefined();
    expect(screen.queryByRole('button', { name: /resolve/i })).toBeNull();
  });

  // The run path stages every comment the same way, but its store takes both
  // verbs locally, so `pending` must not gate anything there.
  it('a pending run draft is untouched — both controls stay', () => {
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

  it('a failed reply keeps the text and says what went wrong', async () => {
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

  it('a sent reply clears the box', async () => {
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

  it('a failed resolve is reported rather than dropped', async () => {
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

describe('ReviewComposer — a rejected save', () => {
  // The composer used to close on submit regardless of what the write did,
  // so a rejected POST discarded the note with no trace of it anywhere.
  it('a failed submit keeps the composed note on screen', async () => {
    let closed = false;
    renderComposer({
      destination: 'github',
      onSubmit: boom,
      onCancel: () => {
        closed = true;
      },
      onSaved: () => {
        closed = true;
      },
    });

    const box = screen.getByRole<HTMLTextAreaElement>('textbox');
    fireEvent.change(box, { target: { value: 'Guard this branch.' } });
    fireEvent.click(screen.getByRole('button', { name: /add comment/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());
    expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe(
      'Guard this branch.'
    );
    expect(closed).toBe(false);
  });

  it('a successful submit hands the trimmed body up once', async () => {
    const bodies: string[] = [];
    renderComposer({
      destination: 'github',
      onSubmit: (body) => {
        bodies.push(body);
        return Promise.resolve(comment());
      },
    });

    const box = screen.getByRole<HTMLTextAreaElement>('textbox');
    fireEvent.change(box, { target: { value: '  Guard this branch.  ' } });
    fireEvent.click(screen.getByRole('button', { name: /add comment/i }));

    await waitFor(() => expect(bodies).toEqual(['Guard this branch.']));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
