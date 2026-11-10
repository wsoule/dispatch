import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';

import type { DispatchProjectData } from '../hooks/useDispatchProject';

// The review diff reaches `PierreWorkerPool`, whose `?worker&url` import
// `bun test` cannot resolve: stubbed to a passthrough.
void mock.module('@/components/runs/PierreWorkerPool', () => ({
  PierreWorkerPool: ({ children }: { children: ReactNode }) => children,
}));
const { PrReviewView } = await import('./PrReviewView');

// A client whose every call stays in flight: the page renders its frame
// (head, toolbar, columns) around loading states, which is all these tests
// read. `baseUrl` is the one plain field the query keys use.
function pendingClient(): unknown {
  return new Proxy(
    { baseUrl: 'http://127.0.0.1:1' },
    {
      get: (target, prop) =>
        prop in target
          ? target[prop as keyof typeof target]
          : () => new Promise(() => {}),
    }
  );
}

function fakeData(): DispatchProjectData {
  return {
    client: pendingClient(),
    port: 1,
    portLoading: false,
    portError: false,
    portErrorDetail: null,
    repoPrs: null,
    retryEnsureDispatchd: () => {},
  } as unknown as DispatchProjectData;
}

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <PrReviewView data={fakeData()} prNumber={7} onBack={() => {}} />
    </QueryClientProvider>
  );
}

afterEach(() => window.localStorage.clear());

// Each side toggle keeps one name and says its state through aria-pressed,
// so a screen reader never hears "Hide files, pressed".
test('the files and review toggles keep their names and report aria-pressed', () => {
  renderPage();
  const files = screen.getByRole('button', { name: 'Files' });
  const review = screen.getByRole('button', { name: 'Review' });
  expect(files.getAttribute('aria-pressed')).toBe('true');
  expect(review.getAttribute('aria-pressed')).toBe('true');

  fireEvent.click(files);
  fireEvent.click(review);
  expect(
    screen.getByRole('button', { name: 'Files' }).getAttribute('aria-pressed')
  ).toBe('false');
  expect(
    screen.getByRole('button', { name: 'Review' }).getAttribute('aria-pressed')
  ).toBe('false');
  expect(screen.queryByRole('button', { name: /hide|show/i })).toBeNull();
});

test('the toggles persist, so a reload opens the panels as they were left', () => {
  const first = renderPage();
  fireEvent.click(screen.getByRole('button', { name: 'Files' }));
  first.unmount();
  renderPage();
  expect(
    screen.getByRole('button', { name: 'Files' }).getAttribute('aria-pressed')
  ).toBe('false');
  expect(
    screen.getByRole('button', { name: 'Review' }).getAttribute('aria-pressed')
  ).toBe('true');
});
