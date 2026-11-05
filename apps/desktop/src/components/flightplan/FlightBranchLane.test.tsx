import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, test } from 'bun:test';

import { FlightBranchLane } from './FlightBranchLane';

const OPEN_STORAGE_KEY = 'dispatch:flight-branches-open';

beforeEach(() => window.localStorage.clear());

function renderLane() {
  return render(
    <FlightBranchLane
      groups={[
        {
          key: 'e-1',
          title: 'Search',
          integration: 'milestone/e-1',
          tasks: [],
        },
      ]}
      branches={[]}
      latestRunByTaskId={new Map()}
      liveRunStateByTaskId={new Map()}
      refFor={(id) => id}
      focusedId={null}
      onOpenNode={() => {}}
    />
  );
}

function trigger(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    '[data-slot=flight-branch-lane] button[aria-expanded]'
  );
  if (button === null) throw new Error('no Branches trigger');
  return button;
}

describe('FlightBranchLane', () => {
  test('starts folded under its Branches section', () => {
    const { container } = renderLane();
    const lane = container.querySelector('[data-slot=flight-branch-lane]');
    expect(lane?.getAttribute('aria-label')).toBe('Branches');
    expect(trigger(container).getAttribute('aria-expanded')).toBe('false');
    expect(trigger(container).textContent).toBe('Branches0');
    expect(container.querySelector('[data-slot=flight-branch-group]')).toBe(
      null
    );
  });

  test('opening and closing it is remembered', () => {
    const { container, unmount } = renderLane();
    fireEvent.click(trigger(container));
    expect(trigger(container).getAttribute('aria-expanded')).toBe('true');
    expect(window.localStorage.getItem(OPEN_STORAGE_KEY)).toBe('1');
    expect(
      container
        .querySelector('[data-slot=flight-branch-group]')
        ?.getAttribute('data-group')
    ).toBe('e-1');
    expect(container.textContent).toContain('milestone/e-1');
    expect(container.textContent).toContain('not created yet');
    unmount();

    // A fresh lane reads the stored choice and opens.
    const again = renderLane();
    expect(trigger(again.container).getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(trigger(again.container));
    expect(window.localStorage.getItem(OPEN_STORAGE_KEY)).toBe('0');
    expect(trigger(again.container).getAttribute('aria-expanded')).toBe(
      'false'
    );
  });
});
