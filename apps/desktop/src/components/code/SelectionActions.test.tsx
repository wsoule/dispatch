import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, mock } from 'bun:test';
import { createRef } from 'react';

import type { CodeSelection, SelectionAction } from './SelectionActions';
import { SelectionActions } from './SelectionActions';

const SELECTION: CodeSelection = {
  file: 'src/a.ts',
  startLine: 2,
  endLine: 4,
  text: 'const a = 1;',
};

const CHAT_ACTION: SelectionAction = {
  id: 'chat',
  label: 'Add to chat',
  icon: null,
  onInvoke: () => {},
};

describe('SelectionActions', () => {
  it('renders nothing when there is no selection', () => {
    const { container } = render(
      <SelectionActions
        containerRef={createRef<HTMLElement>()}
        selection={null}
        actions={[CHAT_ACTION]}
      />
    );
    expect(container.textContent).toBe('');
  });

  it('renders one control per action', () => {
    render(
      <SelectionActions
        containerRef={createRef<HTMLElement>()}
        selection={SELECTION}
        actions={[
          CHAT_ACTION,
          { id: 'copy', label: 'Copy', icon: null, onInvoke: () => {} },
        ]}
      />
    );
    expect(screen.getByRole('button', { name: 'Add to chat' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
  });

  it('hands the live selection to the invoked action', () => {
    const onInvoke = mock(() => {});
    render(
      <SelectionActions
        containerRef={createRef<HTMLElement>()}
        selection={SELECTION}
        actions={[{ ...CHAT_ACTION, onInvoke }]}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add to chat' }));
    expect(onInvoke).toHaveBeenCalledWith(SELECTION);
  });
});
