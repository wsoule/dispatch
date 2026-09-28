import type {
  ApiClient,
  MemoryHealth,
  MemoryIngestProblem,
} from '@dispatch/client';
import { ApiError } from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { describe, expect, it, mock } from 'bun:test';

import { health, report } from '../../lib/memory.test-helper';
import { dataWith, testConfig } from './fixtures.test-helper';
import { MemorySection } from './MemorySection';

type Identity = Awaited<ReturnType<ApiClient['memoryIdentity']>>;

const IDENTITY: Identity = {
  identity: 'self',
  aliases: [{ projectKey: 'dispatch', handle: 'wyat' }],
  placeholderEmail: false,
};

const PROBLEM: MemoryIngestProblem = {
  id: 'ip-000001',
  lineage: 'run-r-9f2c01',
  file: 'notes/huge.md',
  reason: 'larger than 64 KiB',
  size: 1_048_576,
  at: '2026-09-25T10:00:00.000Z',
};

// A client with the calls the page makes, each recorded; the rest are absent.
function memoryClient(
  over: {
    health?: MemoryHealth;
    identity?: Identity | Error;
    problems?: MemoryIngestProblem[];
  } = {}
) {
  return {
    memoryHealth: mock(() => Promise.resolve(over.health ?? health())),
    memoryIdentity: mock(() =>
      over.identity instanceof Error
        ? Promise.reject(over.identity)
        : Promise.resolve(over.identity ?? IDENTITY)
    ),
    listIngestProblems: mock(() =>
      Promise.resolve({ problems: over.problems ?? [] })
    ),
    importClaude: mock((_opts?: { from?: string; none?: boolean }) =>
      Promise.resolve({ report: {} })
    ),
    acceptIngestProblem: mock((_id: string) =>
      Promise.resolve({ status: 'active', id: 'mem-1', handle: 'huge' })
    ),
    startMemoryLink: mock((_opts?: { fresh?: boolean }) =>
      Promise.resolve({
        code: 'k7m2-q9xd',
        expiresAt: '2026-09-25T10:10:00.000Z',
      })
    ),
    completeMemoryLink: mock((_code: string) =>
      Promise.resolve({ identity: 'self' })
    ),
  };
}

function renderSection(
  client: ReturnType<typeof memoryClient>,
  saved: unknown[] = []
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemorySection
        data={dataWith({
          client: client as unknown as ApiClient,
          port: 4321,
        })}
        config={testConfig}
        onSave={(patch) => Promise.resolve(void saved.push(patch))}
      />
    </QueryClientProvider>
  );
  return saved;
}

// Base UI commits a select item on a click that began on it, so press first.
function chooseOption(name: string) {
  const option = screen.getByRole('option', { name });
  fireEvent.pointerDown(option);
  fireEvent.click(option);
}

describe('MemorySection', () => {
  it('shows the store, its warnings, the parity report and pinned overflow', async () => {
    renderSection(
      memoryClient({
        health: health({
          configWarnings: [
            {
              key: 'memory.indexTokens',
              message:
                'memory.indexTokens must be an integer from 200 to 4000; using 1000',
            },
          ],
          ledgerImport: report(),
          personal: {
            available: false,
            reason: 'personal memory unavailable: database is locked',
          },
          pinnedOverflow: true,
        }),
      })
    );
    expect(
      await screen.findByText(
        '15 entries · 2 open proposals · full-text search'
      )
    ).toBeTruthy();
    expect(
      screen.getByText(
        'memory.indexTokens must be an integer from 200 to 4000; using 1000'
      )
    ).toBeTruthy();
    expect(
      screen.getByText('personal memory unavailable: database is locked')
    ).toBeTruthy();
    expect(screen.getByText(/Pinned entries alone exceed/)).toBeTruthy();
    // The matcher collapses the report's column padding to single spaces.
    expect(screen.getByText(/ledger rows read 330 /)).toBeTruthy();
  });

  it('says why memory is unavailable', async () => {
    renderSection(
      memoryClient({
        health: health({
          available: false,
          reason: 'memory.db is from a newer Dispatch',
          claudeImport: null,
        }),
      })
    );
    expect(
      await screen.findByText('Unavailable: memory.db is from a newer Dispatch')
    ).toBeTruthy();
    expect(screen.queryByText('Claude notes')).toBeNull();
  });

  it('lists where unconfirmed Claude notes may be, and takes either answer', async () => {
    const client = memoryClient({
      health: health({
        claudeImport: {
          state: 'unconfirmed',
          source: null,
          candidates: ['/Users/x/.claude/projects/-a/memory'],
        },
      }),
    });
    renderSection(client);
    expect(
      await screen.findByText('/Users/x/.claude/projects/-a/memory')
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Import from here' }));
    await waitFor(() =>
      expect(client.importClaude).toHaveBeenCalledWith({
        from: '/Users/x/.claude/projects/-a/memory',
      })
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'I have no Claude notes' })
    );
    await waitFor(() =>
      expect(client.importClaude).toHaveBeenCalledWith({ none: true })
    );
  });

  it('imports the Claude notes again', async () => {
    const client = memoryClient();
    renderSection(client);
    expect(
      await screen.findByText(/Imported from \/Users\/x\/.claude/)
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Import again' }));
    await waitFor(() => expect(client.importClaude).toHaveBeenCalledTimes(1));
    expect(client.importClaude.mock.calls[0]).toEqual([]);
  });

  it('shows the Claude import only to the daemon’s own human', async () => {
    renderSection(memoryClient({ health: health({ claudeImport: null }) }));
    await screen.findByText('15 entries · 2 open proposals · full-text search');
    expect(screen.queryByText('Claude notes')).toBeNull();
  });

  it('accepts a skipped Claude file', async () => {
    const client = memoryClient({ problems: [PROBLEM] });
    renderSection(client);
    const row = (await screen.findByText('notes/huge.md')).closest(
      '[data-settings-row]'
    );
    if (!(row instanceof HTMLElement)) throw new Error('no problem row');
    expect(within(row).getByText(/larger than 64 KiB/)).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: 'Accept' }));
    await waitFor(() =>
      expect(client.acceptIngestProblem).toHaveBeenCalledWith('ip-000001')
    );
  });

  it('shows the identity, warns about the placeholder email, and issues a link code', async () => {
    const client = memoryClient({
      identity: { ...IDENTITY, placeholderEmail: true },
    });
    renderSection(client);
    expect(await screen.findByText(/local@localhost/)).toBeTruthy();
    expect(screen.getByText('dispatch')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Get a link code' }));
    expect(await screen.findByText('k7m2-q9xd')).toBeTruthy();
    expect(client.startMemoryLink).toHaveBeenCalledWith();
  });

  it('links this project with a code from another', async () => {
    const client = memoryClient();
    renderSection(client);
    const input = await screen.findByRole('textbox', { name: 'Link code' });
    fireEvent.change(input, { target: { value: ' k7m2-q9xd ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Link' }));
    await waitFor(() =>
      expect(client.completeMemoryLink).toHaveBeenCalledWith('k7m2-q9xd')
    );
  });

  it('offers a link or a fresh start when the handle was bound to someone else', async () => {
    const client = memoryClient({
      identity: new ApiError(
        'this handle was bound to someone else; link or start fresh',
        409
      ),
    });
    renderSection(client);
    expect(
      await screen.findByText(
        'this handle was bound to someone else; link or start fresh'
      )
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start fresh' }));
    await waitFor(() =>
      expect(client.startMemoryLink).toHaveBeenCalledWith({ fresh: true })
    );
  });

  it('writes claudeAutoMemory and indexTokens through the config patch', async () => {
    const saved = renderSection(memoryClient());
    await screen.findByText('15 entries · 2 open proposals · full-text search');
    fireEvent.click(
      screen.getByRole('combobox', { name: 'Claude’s memory in runs' })
    );
    chooseOption('Export to Claude');
    const tokens = screen.getByLabelText('Index budget');
    expect((tokens as HTMLInputElement).value).toBe('1000');
    fireEvent.change(tokens, { target: { value: '1500' } });
    fireEvent.blur(tokens);
    fireEvent.change(tokens, { target: { value: '9000' } });
    fireEvent.blur(tokens);
    expect(saved).toEqual([
      { memory: { claudeAutoMemory: 'export' } },
      { memory: { indexTokens: 1500 } },
    ]);
  });
});
