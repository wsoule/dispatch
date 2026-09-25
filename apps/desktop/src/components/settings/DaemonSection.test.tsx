import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render as rtlRender, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';
import type { ReactElement } from 'react';

import { DaemonSection } from './DaemonSection';
import { dataWith, testProject as project } from './fixtures.test-helper';

const data = dataWith();

// A query client keeps the section mountable if it grows a fetching group again.
function render(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return rtlRender(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>
  );
}

// The old copy said only "this view is read-only" — the reason matters, because
// a status is stored by name in every task file on disk.
// Statuses moved to Settings → General, where they are editable; the Daemon
// page keeps to the daemon itself.
test('statuses are no longer a read-only list here', () => {
  render(<DaemonSection activeProject={project} data={data} />);
  expect(screen.queryByRole('heading', { name: 'Tracker config' })).toBeNull();
});

test('a failed daemon start shows the captured detail', () => {
  render(
    <DaemonSection
      activeProject={project}
      data={{ ...data, portError: true, portErrorDetail: 'port 7777 in use' }}
    />
  );
  expect(screen.getByText(/port 7777 in use/)).toBeDefined();
});

// The daemon row reads its state as a sentence-case word beside the dot.
test('the daemon status reads Running while a client is up', () => {
  render(<DaemonSection activeProject={project} data={data} />);
  expect(screen.getByRole('heading', { name: 'Status' })).toBeDefined();
  expect(screen.getByText('Dispatch for this project')).toBeDefined();
  expect(screen.getByText('Running')).toBeDefined();
});
