import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, mock } from 'bun:test';

import type {
  CodeSelection,
  SelectionAction,
  SelectionAnchor,
} from './SelectionActions';
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

// A selection well down a wide diff: room above it, nowhere near either edge.
const ANCHOR: SelectionAnchor = {
  top: 200,
  bottom: 260,
  left: 48,
  width: 900,
};

function bar(): HTMLElement {
  return screen.getByRole('toolbar', { name: 'Selection actions' });
}

describe('SelectionActions', () => {
  it('renders nothing when there is no selection', () => {
    const { container } = render(
      <SelectionActions
        selection={null}
        anchor={ANCHOR}
        actions={[CHAT_ACTION]}
      />
    );
    expect(container.textContent).toBe('');
  });

  it('renders one control per action', () => {
    render(
      <SelectionActions
        selection={SELECTION}
        anchor={ANCHOR}
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
        selection={SELECTION}
        anchor={ANCHOR}
        actions={[{ ...CHAT_ACTION, onInvoke }]}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add to chat' }));
    expect(onInvoke).toHaveBeenCalledWith(SELECTION);
  });
});

describe('SelectionActions — where it lands', () => {
  it('hangs above the first selected row', () => {
    render(
      <SelectionActions
        selection={SELECTION}
        anchor={ANCHOR}
        actions={[CHAT_ACTION]}
      />
    );

    expect(bar().style.top).toBe('200px');
    expect(bar().style.left).toBe('48px');
    // Hanging above means being pulled up by its own height, which is only knowable in CSS.
    expect(bar().className).toContain('-translate-y-full');
  });

  // A selection at the very top of the pane has nothing above it to hang in; the bar drops
  // below the last row rather than being clipped off the top.
  it('drops below the last row when there is no room above', () => {
    render(
      <SelectionActions
        selection={SELECTION}
        anchor={{ ...ANCHOR, top: 6, bottom: 66 }}
        actions={[CHAT_ACTION]}
      />
    );

    expect(bar().style.top).toBe('66px');
    expect(bar().className).not.toContain('-translate-y-full');
  });

  it('pulls the bar back so it cannot run off the right edge', () => {
    render(
      <SelectionActions
        selection={SELECTION}
        anchor={{ ...ANCHOR, left: 780, width: 800 }}
        actions={[CHAT_ACTION]}
      />
    );

    // 800 wide, and the bar needs 260 of it.
    expect(bar().style.left).toBe('540px');
  });

  it('never places the bar off the left edge', () => {
    render(
      <SelectionActions
        selection={SELECTION}
        anchor={{ ...ANCHOR, left: 10, width: 120 }}
        actions={[CHAT_ACTION]}
      />
    );

    expect(bar().style.left).toBe('0px');
  });

  // Without an anchor the bar is still reachable, just unplaced — a control in the wrong place
  // beats one that is not there.
  it('renders unpositioned when there is nowhere measured to put it', () => {
    render(
      <SelectionActions
        selection={SELECTION}
        anchor={null}
        actions={[CHAT_ACTION]}
      />
    );

    expect(bar().style.top).toBe('');
    expect(bar().style.left).toBe('');
  });
});
