import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, mock, test } from 'bun:test';

import {
  ToolApprovalCard,
  type ToolApprovalDecision,
} from './tool-approval-card';

function card(
  onDecide: (decision: ToolApprovalDecision) => Promise<void>,
  over: Partial<Parameters<typeof ToolApprovalCard>[0]> = {}
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
    expect(screen.getByText('Bash: git status')).toBeDefined();

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
  });

  test('deny sends the trimmed reason, or none when the box is left empty', async () => {
    const onDecide = mock((_: ToolApprovalDecision) => Promise.resolve());
    card(onDecide);

    fireEvent.click(
      screen.getByRole('radio', { name: /^Deny and tell it why/ })
    );
    expect(onDecide).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Reason for denying'), {
      target: { value: ' not on main ' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Deny and tell it why' })
    );
    await settle();

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

  // The options are disabled while the reason is written, which the primitive
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
      />
    );
    fireEvent.click(screen.getByRole('radio', { name: /^Approve once/ }));
    expect(onDecide).not.toHaveBeenCalled();
  });
});
