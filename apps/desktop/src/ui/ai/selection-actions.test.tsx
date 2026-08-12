import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';

import {
  defaultSelectionActions,
  menuPlacement,
  SelectionActionsMenu,
} from './selection-actions';

// happy-dom has no real layout engine, so a selection's `getBoundingClientRect()` always
// reads zeros — the fixtures below stand in for whatever rect a caller's `useTextSelection`
// would have produced from a real selection, letting the tests cover the menu's positioning
// math without touching the Selection API at all.
function rect(overrides: Partial<Record<keyof DOMRect, number>>): DOMRect {
  const values = {
    top: 240,
    bottom: 260,
    left: 100,
    right: 300,
    width: 200,
    height: 20,
    x: 100,
    y: 240,
    ...overrides,
  };
  return { ...values, toJSON: () => values } as DOMRect;
}

const RECT = rect({});

describe('menuPlacement', () => {
  test('a rect with room above stays above, centered on it', () => {
    const placement = menuPlacement(RECT);
    expect(placement.top).toBe(240);
    expect(placement.left).toBe(200);
    expect(placement.transform).toBe('translate(-50%, calc(-100% - 8px))');
  });

  test('a rect too close to the viewport top flips below instead', () => {
    const nearTop = rect({ top: 10, bottom: 30, left: 100, width: 200 });
    const placement = menuPlacement(nearTop);
    expect(placement.top).toBe(30);
    expect(placement.left).toBe(200);
    expect(placement.transform).toBe('translate(-50%, 8px)');
  });

  test('respects a supplied viewportTop instead of the window top', () => {
    // Room above the rect (top: 60) but not above a scroll container starting at 50 —
    // 60 - 8 (gap) - 36 (menu height estimate) = 16, which is below viewportTop: 50.
    const withinScrolledPane = rect({ top: 60, bottom: 80 });
    const placement = menuPlacement(withinScrolledPane, { viewportTop: 50 });
    expect(placement.top).toBe(80);
    expect(placement.transform).toBe('translate(-50%, 8px)');
  });

  test('clamps the horizontal anchor to stay within the viewport when width is given', () => {
    const nearLeftEdge = rect({ left: -50, width: 20 });
    const clampedLeft = menuPlacement(nearLeftEdge, {
      viewportWidth: 400,
    }).left;
    expect(clampedLeft).toBe(8);

    const nearRightEdge = rect({ left: 390, width: 20 });
    const clampedRight = menuPlacement(nearRightEdge, {
      viewportWidth: 400,
    }).left;
    expect(clampedRight).toBe(392);
  });

  test('leaves the horizontal anchor unclamped when no viewportWidth is given', () => {
    const nearLeftEdge = rect({ left: -50, width: 20 });
    expect(menuPlacement(nearLeftEdge).left).toBe(-40);
  });
});

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

  test('flips below a selection too close to the top of the viewport', () => {
    render(
      <SelectionActionsMenu
        actions={defaultSelectionActions}
        onAction={() => {}}
        position={rect({ top: 10, bottom: 30, left: 100, width: 200 })}
      />
    );

    const menu = screen.getByRole('toolbar', { name: 'Selection actions' });
    expect(menu.style.top).toBe('30px');
    expect(menu.style.transform).toBe('translate(-50%, 8px)');
  });
});
