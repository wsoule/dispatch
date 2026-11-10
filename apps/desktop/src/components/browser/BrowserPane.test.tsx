import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { BrowserPane } from './BrowserPane';

function pane(url: string | null, navigated: string[] = []) {
  return render(
    <BrowserPane
      url={url}
      onNavigate={(next) => navigated.push(next)}
      onClose={() => {}}
      daemonBaseUrl="http://127.0.0.1:4771"
      onOpenExternal={() => {}}
    />
  );
}

test('an address typed and submitted navigates to its normalised URL', () => {
  const navigated: string[] = [];
  pane(null, navigated);
  const field = screen.getByRole('textbox', { name: 'Address' });
  fireEvent.change(field, { target: { value: 'localhost:5173' } });
  fireEvent.submit(field);
  expect(navigated).toEqual(['http://localhost:5173/']);
});

test('something that is not an address says so and navigates nowhere', () => {
  const navigated: string[] = [];
  pane(null, navigated);
  const field = screen.getByRole('textbox', { name: 'Address' });
  fireEvent.change(field, { target: { value: 'not an address' } });
  fireEvent.submit(field);
  expect(navigated).toEqual([]);
  expect(screen.getByRole('alert').textContent).toContain('web address');
});

test('a page shows in a sandboxed frame', () => {
  const { container } = pane('http://localhost:5173/');
  const frame = container.querySelector('iframe');
  expect(frame?.getAttribute('src')).toBe('http://localhost:5173/');
  expect(frame?.getAttribute('sandbox')).toContain('allow-scripts');
});

test("the daemon's own address is refused rather than framed", () => {
  const { container } = pane('http://127.0.0.1:4771/');
  expect(container.querySelector('iframe')).toBeNull();
  expect(screen.getByTestId('browser-pane').textContent).toContain(
    "daemon's own address"
  );
});
