import { fireEvent, render, screen } from '@testing-library/react';
import { expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';

import { dataWith } from '../settings/fixtures.test-helper';

// The Diffs page's preview imports a Vite-only worker specifier `bun test` cannot resolve:
// stubbed to a passthrough, as SettingsView.test.tsx does, before the panel is imported.
void mock.module('@/components/runs/PierreWorkerPool', () => ({
  PierreWorkerPool: ({ children }: { children: ReactNode }) => children,
}));
const { SettingsPanel } = await import('./SettingsPanel');

function renderPanel() {
  const onClose = mock(() => {});
  render(
    <>
      <button type="button">Gear</button>
      <SettingsPanel activeProject={null} data={dataWith()} onClose={onClose} />
    </>
  );
  return { onClose, panel: screen.getByTestId('settings-panel') };
}

test('the panel is a modal dialog named Settings that takes focus', () => {
  const { panel } = renderPanel();
  const dialog = screen.getByRole('dialog', { name: 'Settings' });
  expect(dialog.getAttribute('data-testid')).toBe('settings-panel');
  expect(panel.getAttribute('aria-modal')).toBe('true');
  expect(document.activeElement).toBe(panel);
});

test('Escape inside the panel closes it', () => {
  const { onClose, panel } = renderPanel();
  fireEvent.keyDown(panel, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledTimes(1);
});

// A popup inside that takes Escape first marks it handled.
test('an Escape a popup already handled leaves the panel open', () => {
  const { onClose, panel } = renderPanel();
  panel.addEventListener('keydown', (event) => event.preventDefault());
  fireEvent.keyDown(panel, { key: 'Escape' });
  expect(onClose).not.toHaveBeenCalled();
});

// A legacy dialog a hosted page opens is portalled outside the panel and keeps its Escape.
test('an Escape from outside the panel is not the panel’s', () => {
  const { onClose } = renderPanel();
  fireEvent.keyDown(screen.getByRole('button', { name: 'Gear' }), {
    key: 'Escape',
  });
  expect(onClose).not.toHaveBeenCalled();
});

test('the close button and a click on the scrim close it; a click inside does not', () => {
  const { onClose, panel } = renderPanel();
  fireEvent.click(panel);
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
  expect(onClose).toHaveBeenCalledTimes(1);
  const scrim = panel.parentElement;
  if (scrim === null) throw new Error('no scrim');
  fireEvent.click(scrim);
  expect(onClose).toHaveBeenCalledTimes(2);
});
