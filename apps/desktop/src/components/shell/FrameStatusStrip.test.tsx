import type { SyncStatus } from '@dispatch/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { FrameStatusStrip, liveCeilingsLabel } from './FrameStatusStrip';
import { TooltipProvider } from '@/ui/tooltip';

function status(overrides: Partial<SyncStatus> = {}): SyncStatus {
  return {
    pushed: 0,
    pulled: 0,
    state: 'idle',
    detail: null,
    pendingOutgoing: 0,
    pendingIncoming: 0,
    lastSyncedAt: null,
    mergeDriverWarning: null,
    receipts: {
      state: 'disabled',
      detail: null,
      commit: null,
      changed: 0,
      removed: 0,
      problems: 0,
      lastExportedAt: null,
    },
    ...overrides,
  };
}

const props = {
  syncStatus: null as SyncStatus | null,
  onDisableAutoCommit: () => {},
  spendToday: null as number | null,
  onOpenShortcuts: () => {},
  onOpenSettings: () => {},
  onOpenOverseer: () => {},
};

// The strip's tooltips need the provider the app's `SidebarProvider` supplies.
function mount(
  overrides: Partial<Parameters<typeof FrameStatusStrip>[0]> = {}
) {
  return render(
    <TooltipProvider>
      <FrameStatusStrip {...props} {...overrides} />
    </TooltipProvider>
  );
}

test('the ? button opens the shortcuts reference', () => {
  let opened = 0;
  mount({
    onOpenShortcuts: () => {
      opened += 1;
    },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }));
  expect(opened).toBe(1);
});

test('the gear opens Settings', () => {
  let opened = 0;
  mount({
    onOpenSettings: () => {
      opened += 1;
    },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  expect(opened).toBe(1);
});

test('no pill until the first sync status arrives', () => {
  const { container } = mount();
  expect(container.querySelector('[data-slot="sync-pill"]')).toBeNull();
});

test('"Stop committing" is offered only while the board syncer runs', () => {
  let disabled = 0;
  const { rerender } = render(
    <TooltipProvider>
      <FrameStatusStrip
        {...props}
        syncStatus={status()}
        onDisableAutoCommit={() => {
          disabled += 1;
        }}
      />
    </TooltipProvider>
  );
  const stop = screen.getByRole('button', {
    name: 'Stop committing task files to the main branch',
  });
  expect(stop.textContent).toBe('Stop committing');
  expect(stop.getAttribute('title')).toBe(
    'Turn off “Commit task files to the main branch”'
  );
  fireEvent.click(stop);
  expect(disabled).toBe(1);

  rerender(
    <TooltipProvider>
      <FrameStatusStrip {...props} syncStatus={status({ state: 'off' })} />
    </TooltipProvider>
  );
  expect(screen.queryByRole('button', { name: /Stop committing/ })).toBeNull();
  expect(screen.getByText(/Task files not committed/)).toBeTruthy();
});

// Turning it off is a config save; a viewer below decide gets no handler.
test('"Stop committing" is not offered without a handler', () => {
  mount({ syncStatus: status(), onDisableAutoCommit: undefined });
  expect(screen.queryByRole('button', { name: /Stop committing/ })).toBeNull();
});

test('the pill becomes focusable and mirrors its detail lines when it has any', () => {
  const { container, rerender } = render(
    <TooltipProvider>
      <FrameStatusStrip {...props} syncStatus={status()} />
    </TooltipProvider>
  );
  const bare = container.querySelector('[data-slot="sync-pill"]');
  expect(bare?.getAttribute('tabindex')).toBeNull();

  rerender(
    <TooltipProvider>
      <FrameStatusStrip
        {...props}
        syncStatus={status({ pendingOutgoing: 2, pendingIncoming: 1 })}
      />
    </TooltipProvider>
  );
  const pill = container.querySelector('[data-slot="sync-pill"]');
  expect(pill?.getAttribute('tabindex')).toBe('0');
  expect(pill?.textContent).toContain('2 to push. 1 incoming');
});

test('spend shows only once there is spend', () => {
  const { rerender } = mount({ spendToday: 0 });
  expect(screen.queryByText(/today$/)).toBeNull();
  rerender(
    <TooltipProvider>
      <FrameStatusStrip {...props} spendToday={4.5} />
    </TooltipProvider>
  );
  expect(screen.getByText('$4.50 today')).toBeTruthy();
  // Whole dollars drop the cents, the same rule as the ceilings readout beside it.
  rerender(
    <TooltipProvider>
      <FrameStatusStrip {...props} spendToday={12} />
    </TooltipProvider>
  );
  expect(screen.getByText('$12 today')).toBeTruthy();
});

test('the Overseer link opens the overseer', () => {
  let opened = 0;
  mount({
    onOpenOverseer: () => {
      opened += 1;
    },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Assistant' }));
  expect(opened).toBe(1);
});

test("live milestones read beside today's spend, against their ceilings", () => {
  const { container } = mount({
    spendToday: 4.5,
    ceilings: { live: 2, settledUsd: 41.2, ceilingUsd: 120 },
  });
  expect(screen.getByText('$4.50 today')).toBeTruthy();
  expect(
    screen.getByText('2 milestones live · $41.20 of $120 ceilings')
  ).toBeTruthy();
  // The separator sits between the two readouts, and only then.
  expect(container.textContent).toContain(
    '$4.50 today·2 milestones live · $41.20 of $120 ceilings'
  );
});

test('the ceilings readout stands alone when today has no spend yet', () => {
  const { container } = mount({
    spendToday: 0,
    ceilings: { live: 1, settledUsd: 0, ceilingUsd: 30 },
  });
  expect(
    screen.getByText('1 milestone live · $0 of $30 ceilings')
  ).toBeTruthy();
  expect(container.textContent).not.toContain('·1 milestone');
});

test('no ceiling on any live session prints the spend alone', () => {
  mount({ ceilings: { live: 1, settledUsd: 12.345, ceilingUsd: null } });
  expect(screen.getByText('1 milestone live · $12.35 spent')).toBeTruthy();
});

test('nothing live, null or absent shows no ceilings readout', () => {
  const { container, rerender } = mount({
    ceilings: { live: 0, settledUsd: 41.2, ceilingUsd: 120 },
  });
  expect(container.querySelector('[data-slot="live-ceilings"]')).toBeNull();
  rerender(
    <TooltipProvider>
      <FrameStatusStrip {...props} ceilings={null} />
    </TooltipProvider>
  );
  expect(container.querySelector('[data-slot="live-ceilings"]')).toBeNull();
  rerender(
    <TooltipProvider>
      <FrameStatusStrip {...props} spendToday={4.5} />
    </TooltipProvider>
  );
  expect(container.querySelector('[data-slot="live-ceilings"]')).toBeNull();
  expect(container.textContent).not.toContain('·');
});

test('liveCeilingsLabel pluralises and drops cents on whole dollars', () => {
  expect(liveCeilingsLabel({ live: 3, settledUsd: 100, ceilingUsd: 250 })).toBe(
    '3 milestones live · $100 of $250 ceilings'
  );
  expect(
    liveCeilingsLabel({ live: 1, settledUsd: 0.5, ceilingUsd: null })
  ).toBe('1 milestone live · $0.50 spent');
});
