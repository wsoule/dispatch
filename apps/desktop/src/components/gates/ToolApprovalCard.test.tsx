import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, mock, test } from 'bun:test';

import {
  ToolApprovalCard,
  type ToolApprovalCardProps,
  type ToolApprovalDecision,
} from './ToolApprovalCard';

function card(
  onDecide: (decision: ToolApprovalDecision) => Promise<void>,
  over: Partial<ToolApprovalCardProps> = {}
) {
  return render(
    <ToolApprovalCard
      toolName="Bash"
      preview="Bash: git status"
      sessionScope="this conversation"
      onDecide={onDecide}
      {...over}
    />
  );
}

// Lets the decision's promise settle inside act, so its state updates land.
async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('ToolApprovalCard', () => {
  test('an allow decides at once, once or for the scope it names', async () => {
    const onDecide = mock((_: ToolApprovalDecision) => Promise.resolve());
    card(onDecide);
    expect(screen.getByText('Bash: git status', { selector: 'pre' })).toBe(
      screen.getByText('Bash: git status')
    );
    // The preview is a Tab stop (it scrolls), so it is a named region.
    const call = screen.getByRole('region', { name: 'Tool call' });
    expect(call.tabIndex).toBe(0);
    expect(call.textContent).toBe('Bash: git status');
    // The heading names the answers; the tool's name is the detail line.
    expect(
      screen.getByRole('radiogroup', { name: 'Waiting on approval' })
    ).toBeDefined();
    expect(screen.getByText('Bash')).toBeDefined();
    // The card keeps the hook a run log counts.
    expect(
      document.querySelectorAll('[data-slot="tool-approval-card"]').length
    ).toBe(1);

    fireEvent.click(screen.getByRole('radio', { name: /^Approve once/ }));
    await settle();
    fireEvent.click(
      screen.getByRole('radio', { name: /^Allow Bash for this conversation/ })
    );
    await settle();
    expect(onDecide.mock.calls).toEqual([
      [{ allow: true, scope: 'once' }],
      [{ allow: true, scope: 'session' }],
    ]);
  });

  test('without a scope there is no grant past this call', () => {
    card(() => Promise.resolve(), { sessionScope: undefined });
    expect(screen.queryByRole('radio', { name: /^Allow Bash/ })).toBeNull();
    // Approve once is the recommended answer.
    expect(
      screen.getByRole('radio', { name: 'Approve once Recommended' })
    ).toBeDefined();
  });

  test('deny sends the trimmed reason, or none when the box is left empty', async () => {
    const onDecide = mock((_: ToolApprovalDecision) => Promise.resolve());
    card(onDecide);

    fireEvent.click(
      screen.getByRole('radio', { name: /^Deny and tell it why/ })
    );
    expect(onDecide).not.toHaveBeenCalled();
    const reason = screen.getByLabelText('Reason for denying');
    // The caret follows the choice into the box, and nothing else can be
    // picked while it is open.
    expect(document.activeElement).toBe(reason);
    expect(
      screen
        .getByRole('radio', { name: /^Approve once/ })
        .hasAttribute('disabled')
    ).toBe(true);
    expect(
      screen.queryByRole('button', { name: 'Deny and tell it why' })
    ).toBeNull();
    fireEvent.change(reason, { target: { value: ' not on main ' } });
    fireEvent.click(
      screen.getByRole('button', { name: 'Deny and tell it why' })
    );
    await settle();
    expect(screen.queryByLabelText('Reason for denying')).toBeNull();

    // Deny again (it is still the checked answer): the box opens empty.
    fireEvent.click(
      screen.getByRole('radio', { name: /^Deny and tell it why/ })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    await settle();
    expect(onDecide.mock.calls).toEqual([
      [{ allow: false, reason: 'not on main' }],
      [{ allow: false }],
    ]);
  });

  // The options are disabled while the reason is written, which the card
  // otherwise reads as answered; nothing has gone out until Deny is pressed.
  test('a deny is shown as answered only once it is sent', async () => {
    let refuse: (err: Error) => void = () => {};
    card(
      () =>
        new Promise<void>((_, reject) => {
          refuse = reject;
        })
    );
    fireEvent.click(
      screen.getByRole('radio', { name: /^Deny and tell it why/ })
    );
    expect(screen.queryByText(/^Answered/)).toBeNull();
    expect(screen.getByText(/^Selected/).textContent).toBe(
      'Selected — Deny and tell it why'
    );

    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(screen.getByText(/^Answered/).textContent).toBe(
      'Answered — Deny and tell it why'
    );

    // Refused: back to an open reason box, not an answer.
    refuse(new Error('gate closed'));
    await settle();
    expect(screen.queryByText(/^Answered/)).toBeNull();
    expect(screen.getByText(/^Selected/)).toBeDefined();
  });

  test('a failed deny keeps the reason box and what was typed', async () => {
    card(() => Promise.reject(new Error('gate closed')));
    fireEvent.click(
      screen.getByRole('radio', { name: /^Deny and tell it why/ })
    );
    fireEvent.change(screen.getByLabelText('Reason for denying'), {
      target: { value: 'wrong branch' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Deny and tell it why' })
    );
    await settle();
    expect(screen.getByLabelText('Reason for denying')).toHaveProperty(
      'value',
      'wrong branch'
    );
    // Cancel closes the box and clears the pick.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Reason for denying')).toBeNull();
    expect(screen.queryByText(/^Selected/)).toBeNull();
  });

  test('a failed allow is not left showing as picked', async () => {
    card(() => Promise.reject(new Error('gate closed')));
    fireEvent.click(screen.getByRole('radio', { name: /^Approve once/ }));
    await settle();
    expect(screen.queryByText(/^Selected/)).toBeNull();
    expect(
      screen
        .getByRole('radio', { name: /^Approve once/ })
        .hasAttribute('disabled')
    ).toBe(false);
  });

  test('busy and disabled cards take no answer', () => {
    const onDecide = mock((_: ToolApprovalDecision) => Promise.resolve());
    const { rerender } = card(onDecide, { busy: true });
    fireEvent.click(screen.getByRole('radio', { name: /^Approve once/ }));
    rerender(
      <ToolApprovalCard
        toolName="Bash"
        preview="Bash: git status"
        onDecide={onDecide}
        disabled
      >
        <p>Restart daemon to enable approvals</p>
      </ToolApprovalCard>
    );
    const once = screen.getByRole('radio', { name: /^Approve once/ });
    fireEvent.click(once);
    fireEvent.keyDown(once, { key: 'Enter' });
    expect(onDecide).not.toHaveBeenCalled();
    // The caller's notice sits in the card.
    expect(
      screen.getByText('Restart daemon to enable approvals')
    ).toBeDefined();
  });

  // An arrow key only moves between the answers: arrowing onto "Approve
  // once" must not approve the call.
  test('an arrow key never answers', () => {
    const onDecide = mock((_: ToolApprovalDecision) => Promise.resolve());
    card(onDecide);
    const deny = screen.getByRole('radio', { name: /^Deny and tell it why/ });
    const once = screen.getByRole('radio', { name: /^Approve once/ });
    fireEvent.keyDown(deny, { key: 'ArrowUp' });
    fireEvent.click(once);
    fireEvent.keyUp(once, { key: 'ArrowUp' });
    expect(onDecide).not.toHaveBeenCalled();
    expect(screen.queryByText(/^Selected/)).toBeNull();
  });
});
