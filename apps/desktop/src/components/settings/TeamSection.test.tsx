import type { TeamTokenHolder } from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, mock, test } from 'bun:test';

import { NEEDS_DECIDE, OPERATOR_ONLY } from './access';
import { dataWith } from './fixtures.test-helper';
import { grantableTiers, holderDates, TeamSection } from './TeamSection';

function holder(over: Partial<TeamTokenHolder> = {}): TeamTokenHolder {
  return {
    handle: 'ada',
    tier: 'request',
    builtIn: false,
    issuedAt: '2026-09-01T00:00:00.000Z',
    expiresAt: '2026-12-01T00:00:00.000Z',
    lastUsedAt: null,
    expired: false,
    ...over,
  };
}

/** A client stub with just the team calls, each recorded. */
function teamClient(holders: TeamTokenHolder[], origins: string[] = []) {
  return {
    baseUrl: 'http://127.0.0.1:1',
    fetchTeamTokens: mock(() => Promise.resolve(holders)),
    fetchTeamAddress: mock(() =>
      Promise.resolve({ shared: origins.length > 0, origins })
    ),
    issueTeamToken: mock((input: { email?: string; tier?: string }) =>
      Promise.resolve({
        handle: 'grace',
        tier: input.tier ?? 'request',
        token: 'tok-grace-once',
        expiresAt: null,
      })
    ),
    revokeTeamToken: mock(() => Promise.resolve()),
  };
}

function mount(overrides: Parameters<typeof dataWith>[0]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TeamSection data={dataWith({ presence: [], ...overrides })} />
    </QueryClientProvider>
  );
}

describe('grantableTiers', () => {
  test('is your own tier and everything below it', () => {
    expect(grantableTiers('operator')).toEqual([
      'request',
      'decide',
      'operator',
    ]);
    expect(grantableTiers('decide')).toEqual(['request', 'decide']);
    expect(grantableTiers('request')).toEqual(['request']);
    expect(grantableTiers(null)).toEqual([]);
  });
});

describe('holderDates', () => {
  test('reads expiry and last use as one line', () => {
    expect(holderDates(holder())).toMatch(/^Expires .* · never used$/);
    expect(holderDates(holder({ expiresAt: null }))).toMatch(/^Never expires/);
    expect(holderDates(holder({ expired: true }))).toMatch(/^Expired /);
    expect(
      holderDates(holder({ lastUsedAt: '2026-09-20T00:00:00.000Z' }))
    ).toContain('last used');
  });
});

describe('TeamSection', () => {
  test('below decide, it says who to ask instead of offering controls', () => {
    mount({ myTier: 'request', client: teamClient([]) as never });
    expect(screen.getByText('Inviting people')).toBeTruthy();
    expect(screen.getByText(/Needs Can approve access/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Invite/ })).toBeNull();
    // Invites need Can approve, not the owner, and the lock agrees.
    expect(screen.getByLabelText(NEEDS_DECIDE)).toBeTruthy();
    expect(screen.queryByLabelText(OPERATOR_ONLY)).toBeNull();
  });

  test('lists teammates, marks who is online, and leaves the daemon’s own pair out', async () => {
    const client = teamClient([
      holder({ handle: 'wyat', tier: 'operator', builtIn: true }),
      holder({ handle: 'ada' }),
      holder({ handle: 'grace', tier: 'decide' }),
    ]);
    mount({
      myTier: 'operator',
      client: client as never,
      presence: [
        {
          handle: 'ada',
          ref: 'human:ada',
          connections: 1,
          since: '2026-09-22T00:00:00.000Z',
          runs: [],
          viewing: null,
        },
      ],
    });
    await waitFor(() => expect(screen.getByText('grace')).toBeTruthy());
    expect(screen.queryByText('wyat')).toBeNull();
    expect(screen.getByText('ada').parentElement?.textContent).toContain(
      'online'
    );
    expect(screen.getByText('grace').parentElement?.textContent).toContain(
      'offline'
    );
  });

  test('a decide lead cannot remove an operator, and is told why', async () => {
    const client = teamClient([holder({ handle: 'linus', tier: 'operator' })]);
    mount({ myTier: 'decide', client: client as never });
    const remove = await screen.findByRole('button', { name: 'Remove linus' });
    expect((remove as HTMLButtonElement).disabled).toBe(true);
    expect(remove.getAttribute('title')).toContain('above yours');
  });

  test('inviting shows the token once, beside the address to send', async () => {
    const client = teamClient([], ['http://192.168.1.5:4771']);
    mount({ myTier: 'operator', client: client as never });

    fireEvent.change(screen.getByLabelText('Email or handle'), {
      target: { value: 'grace@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Invite/ }));

    await waitFor(() =>
      expect(screen.getByTestId('issued-token').textContent).toBe(
        'tok-grace-once'
      )
    );
    expect(screen.getByText('http://192.168.1.5:4771')).toBeTruthy();
    expect(client.issueTeamToken).toHaveBeenCalledWith({
      email: 'grace@example.com',
      tier: 'request',
      expiresInDays: 90,
    });
  });

  test('on a loopback-only daemon, it explains how teammates get in', async () => {
    const client = teamClient([]);
    mount({ myTier: 'operator', client: client as never });
    fireEvent.change(screen.getByLabelText('Email or handle'), {
      target: { value: 'grace@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Invite/ }));
    await waitFor(() =>
      expect(
        screen.getByText(/only accepts connections from this machine/)
      ).toBeTruthy()
    );
  });

  test('removing someone revokes their token', async () => {
    const client = teamClient([holder({ handle: 'ada' })]);
    mount({ myTier: 'decide', client: client as never });
    fireEvent.click(await screen.findByRole('button', { name: 'Remove ada' }));
    await waitFor(() =>
      expect(client.revokeTeamToken).toHaveBeenCalledWith('ada')
    );
  });
});
