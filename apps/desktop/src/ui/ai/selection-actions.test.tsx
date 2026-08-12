import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';

import {
  defaultSelectionActions,
  SelectionActionsMenu,
} from './selection-actions';

// happy-dom has no real layout engine, so a selection's `getBoundingClientRect()` always
// reads zeros — the fixture below stands in for whatever rect a caller's `useTextSelection`
// would have produced from a real selection, letting the test cover the menu's positioning
// math without touching the Selection API at all.
const RECT_VALUES = {
  top: 240,
  bottom: 260,
  left: 100,
  right: 300,
  width: 200,
  height: 20,
  x: 100,
  y: 240,
};
const RECT = {
  ...RECT_VALUES,
  toJSON: () => RECT_VALUES,
} satisfies DOMRect;

describe('SelectionActionsMenu', () => {
  test('renders every default action label', () => {
    render(
      <SelectionActionsMenu
        actions={defaultSelectionActions}
        onAction={() => {}}
        position={RECT}
      />
    );

    expect(screen.getByText('Explain')).toBeDefined();
    expect(screen.getByText('Improve')).toBeDefined();
    expect(screen.getByText('Shorten')).toBeDefined();
    expect(screen.getByText('Tone')).toBeDefined();
    expect(screen.getByText('Grammar')).toBeDefined();
  });

  test('clicking a plain action calls onAction with its id', () => {
    let calledWith: string | undefined;
    render(
      <SelectionActionsMenu
        actions={defaultSelectionActions}
        onAction={(id) => (calledWith = id)}
        position={RECT}
      />
    );

    fireEvent.click(screen.getByText('Improve'));
    expect(calledWith).toBe('improve');
  });

  test('clicking Tone opens a submenu instead of firing onAction directly', () => {
    let calledWith: string | undefined;
    render(
      <SelectionActionsMenu
        actions={defaultSelectionActions}
        onAction={(id) => (calledWith = id)}
        position={RECT}
      />
    );

    fireEvent.click(screen.getByText('Tone'));

    expect(calledWith).toBeUndefined();
    expect(screen.getByText('Professional')).toBeDefined();
    expect(screen.getByText('Friendly')).toBeDefined();
    expect(screen.getByText('Direct')).toBeDefined();
    // The top-level row is replaced by the submenu, not layered alongside it.
    expect(screen.queryByText('Explain')).toBeNull();
  });

  test('picking a tone submenu item calls onAction with its id and closes the submenu', () => {
    let calledWith: string | undefined;
    render(
      <SelectionActionsMenu
        actions={defaultSelectionActions}
        onAction={(id) => (calledWith = id)}
        position={RECT}
      />
    );

    fireEvent.click(screen.getByText('Tone'));
    fireEvent.click(screen.getByText('Friendly'));

    expect(calledWith).toBe('tone-friendly');
    expect(screen.getByText('Explain')).toBeDefined();
    expect(screen.queryByText('Friendly')).toBeNull();
  });

  test('positions the menu centered above the given rect', () => {
    render(
      <SelectionActionsMenu
        actions={defaultSelectionActions}
        onAction={() => {}}
        position={RECT}
      />
    );

    const menu = screen.getByRole('toolbar', { name: 'Selection actions' });
    expect(menu.style.top).toBe('240px');
    expect(menu.style.left).toBe('200px');
    expect(menu.style.transform).toBe('translate(-50%, calc(-100% - 8px))');
  });
});
