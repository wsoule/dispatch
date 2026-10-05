import type { AgentSummary } from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { describe, expect, mock, test } from 'bun:test';

import { agentRosterKey } from '../../lib/agentRoster';
import { accessFor, NEEDS_DECIDE, SettingsAccessProvider } from './access';
import { AgentRosterSection } from './AgentRosterSection';
import { dataWith } from './fixtures.test-helper';

const PORT = 4321;
const PENDING = 'agent:wyat/cursor.macbook';
const APPROVED = 'agent:wyat/claude-code.macbook';
const REVOKED = 'agent:ada/codex.studio';

function agent(over: Partial<AgentSummary> = {}): AgentSummary {
  return {
    address: APPROVED,
    displayName: 'claude-code.macbook',
    client: 'claude-code',
    status: 'approved',
    muted: false,
    approvedBy: 'human:wyat',
    createdAt: '2026-09-20T10:00:00.000Z',
    ...over,
  };
}

const ROSTER: AgentSummary[] = [
  agent(),
  agent({
    address: PENDING,
    displayName: 'cursor.macbook',
    client: 'cursor',
    status: 'pending',
    approvedBy: null,
  }),
  agent({
    address: REVOKED,
    displayName: 'codex.studio',
    client: 'codex',
    status: 'revoked',
    approvedBy: null,
  }),
];

// A client stub with just the roster calls, each recorded. Every action
// changes the listed agent and resolves to it, as the daemon would.
function rosterClient(initial: AgentSummary[] = ROSTER) {
  let agents = initial;
  const change = (address: string, patch: Partial<AgentSummary>) => {
    const found =
      agents.find((a) => a.address === address) ?? agent({ address });
    const updated = { ...found, ...patch };
    agents = agents.map((a) => (a.address === address ? updated : a));
    return Promise.resolve(updated);
  };
  return {
    baseUrl: 'http://127.0.0.1:1',
    listAgentRoster: mock(() => Promise.resolve({ agents })),
    approveAgent: mock((address: string) =>
      change(address, { status: 'approved' })
    ),
    revokeAgent: mock((address: string) =>
      change(address, { status: 'revoked' })
    ),
    muteAgent: mock((address: string, muted: boolean) =>
      change(address, { muted })
    ),
  };
}

function mount(
  client: unknown,
  tier: 'request' | 'decide' | 'operator' = 'operator',
  me: string | null = null
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <SettingsAccessProvider access={accessFor(tier, false)}>
        <AgentRosterSection
          data={dataWith({
            client: client as never,
            port: PORT,
            me,
            myTier: tier,
          })}
        />
      </SettingsAccessProvider>
    </QueryClientProvider>
  );
  return queryClient;
}

// The roster row naming `address`; the row's own text holds every cell.
async function row(address: string): Promise<HTMLElement> {
  const title = await screen.findByText(address);
  const element = title.closest<HTMLElement>('[data-slot="list-row"]');
  if (element === null) throw new Error(`no row for ${address}`);
  return element;
}

describe('AgentRosterSection', () => {
  test('lists every agent with its client and status, pending first', async () => {
    mount(rosterClient());
    await row(APPROVED);
    const rows = screen
      .getAllByRole('row')
      .map((r) => r.querySelector('[data-slot="list-row-title"]')?.textContent);
    expect(rows).toEqual([
      `${PENDING}cursor`,
      `${APPROVED}claude-code`,
      `${REVOKED}codex`,
    ]);
    expect(within(await row(PENDING)).getByText('Pending')).toBeTruthy();
    expect(within(await row(APPROVED)).getByText('Approved')).toBeTruthy();
    expect(
      within(await row(APPROVED)).getByRole('img', {
        name: 'Approved by wyat',
      })
    ).toBeTruthy();
  });

  test("offers Approve on the owner's revoked Overseer only, never a teammate's agent named overseer", async () => {
    const client = rosterClient([
      agent({ address: 'agent:wyat/overseer', status: 'revoked' }),
      agent({ address: 'agent:ada/overseer', status: 'revoked' }),
    ]);
    mount(client, 'operator', 'human:wyat');
    fireEvent.click(
      within(await row('agent:wyat/overseer')).getByRole('button', {
        name: 'Approve agent:wyat/overseer',
      })
    );
    await waitFor(() =>
      expect(client.approveAgent).toHaveBeenCalledWith('agent:wyat/overseer')
    );
    expect(
      within(await row('agent:ada/overseer')).queryByRole('button', {
        name: 'Approve agent:ada/overseer',
      })
    ).toBeNull();
  });

  test('a revoked row shows its status and offers no actions', async () => {
    mount(rosterClient());
    const revoked = await row(REVOKED);
    expect(within(revoked).getByText('Revoked')).toBeTruthy();
    expect(within(revoked).queryAllByRole('button')).toEqual([]);
  });

  // The client encodes the address into the route; messaging-client.test.ts pins that.
  test('approve is offered only while pending, and calls the client with the address', async () => {
    const client = rosterClient();
    mount(client);
    expect(
      within(await row(APPROVED)).queryByRole('button', { name: /^Approve/ })
    ).toBeNull();
    fireEvent.click(
      within(await row(PENDING)).getByRole('button', {
        name: `Approve ${PENDING}`,
      })
    );
    await waitFor(() => expect(client.approveAgent).toHaveBeenCalledTimes(1));
    expect(client.approveAgent.mock.calls[0]).toEqual([PENDING]);
  });

  test('mute and unmute call the client with the address', async () => {
    const client = rosterClient([
      agent(),
      agent({ address: PENDING, status: 'pending', muted: true }),
    ]);
    mount(client);
    expect(within(await row(PENDING)).getByText('Muted')).toBeTruthy();
    fireEvent.click(
      within(await row(APPROVED)).getByRole('button', {
        name: `Mute ${APPROVED}`,
      })
    );
    fireEvent.click(
      within(await row(PENDING)).getByRole('button', {
        name: `Unmute ${PENDING}`,
      })
    );
    await waitFor(() => expect(client.muteAgent).toHaveBeenCalledTimes(2));
    expect(client.muteAgent.mock.calls).toEqual([
      [APPROVED, true],
      [PENDING, false],
    ]);
  });

  test('revoke asks first, and only a confirm calls the client', async () => {
    const client = rosterClient();
    mount(client);
    const revoke = async () =>
      fireEvent.click(
        within(await row(APPROVED)).getByRole('button', {
          name: `Revoke ${APPROVED}`,
        })
      );

    await revoke();
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain(APPROVED);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(client.revokeAgent).not.toHaveBeenCalled();

    await revoke();
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Revoke',
      })
    );
    await waitFor(() => expect(client.revokeAgent).toHaveBeenCalledTimes(1));
    expect(client.revokeAgent.mock.calls[0]).toEqual([APPROVED]);
  });

  test('without decide, every action is disabled and the lock says why', async () => {
    const client = rosterClient();
    mount(client, 'request');
    const pending = await row(PENDING);
    const buttons = within(pending).getAllByRole('button');
    expect(buttons.length).toBe(3);
    for (const button of buttons) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
    expect(screen.getByLabelText(NEEDS_DECIDE)).toBeTruthy();
  });

  // A disabled button takes no focus, so its tooltip never reaches a keyboard.
  test('without decide, the reason is written on the page, not only in tooltips', async () => {
    mount(rosterClient(), 'request');
    await row(PENDING);
    expect(screen.queryByText(NEEDS_DECIDE)?.textContent).toBe(NEEDS_DECIDE);
  });

  test('with decide, no reason is written out', async () => {
    mount(rosterClient());
    await row(PENDING);
    expect(screen.queryByText(NEEDS_DECIDE)?.textContent).toBeUndefined();
  });

  // The pressed button leaves the row once the change lands; focus must not fall to the page.
  test('after an approve, focus stays in the row', async () => {
    const client = rosterClient();
    mount(client);
    const approve = within(await row(PENDING)).getByRole('button', {
      name: `Approve ${PENDING}`,
    });
    approve.focus();
    fireEvent.click(approve);
    await waitFor(async () =>
      expect(within(await row(PENDING)).queryByText('Approved')).not.toBeNull()
    );
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('aria-label')).toBe(
        `Mute ${PENDING}`
      )
    );
  });

  test('after a revoke, focus moves to the roster rather than the page', async () => {
    const client = rosterClient();
    mount(client);
    const revoke = within(await row(APPROVED)).getByRole('button', {
      name: `Revoke ${APPROVED}`,
    });
    revoke.focus();
    fireEvent.click(revoke);
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Revoke',
      })
    );
    await waitFor(async () =>
      expect(within(await row(APPROVED)).queryByText('Revoked')).not.toBeNull()
    );
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Agents')
    );
  });

  test('a refused action says why beside the roster', async () => {
    const client = rosterClient();
    client.approveAgent.mockImplementation(() =>
      Promise.reject(new Error('no agent agent:wyat/cursor.macbook'))
    );
    mount(client);
    fireEvent.click(
      within(await row(PENDING)).getByRole('button', {
        name: `Approve ${PENDING}`,
      })
    );
    expect((await screen.findByRole('alert')).textContent).toBe(
      'no agent agent:wyat/cursor.macbook'
    );
  });

  // Approving from Needs you or the CLI answers the gate elsewhere; the data
  // layer invalidates this key, and the row must stop offering Approve.
  test('a change made elsewhere shows once the roster key is invalidated', async () => {
    const client = rosterClient();
    const queryClient = mount(client);
    const pending = await row(PENDING);
    expect(within(pending).getByText('Pending')).toBeTruthy();

    client.listAgentRoster.mockImplementation(() =>
      Promise.resolve({
        agents: ROSTER.map((a) =>
          a.address === PENDING
            ? { ...a, status: 'approved' as const, approvedBy: 'human:ada' }
            : a
        ),
      })
    );
    await act(() =>
      queryClient.invalidateQueries({ queryKey: agentRosterKey(PORT) })
    );

    await waitFor(async () =>
      expect(within(await row(PENDING)).getByText('Approved')).toBeTruthy()
    );
    expect(
      within(await row(PENDING)).queryByRole('button', { name: /^Approve/ })
    ).toBeNull();
  });

  test('an empty roster says how an agent gets on it', async () => {
    mount(rosterClient([]));
    expect(await screen.findByText('No agents yet')).toBeTruthy();
    expect(screen.getByText(/dispatch mcp/)).toBeTruthy();
  });

  test('marks a remote agent and offers only Mute for it', async () => {
    mount(
      rosterClient([
        agent({
          address: 'agent:bob/codex',
          displayName: 'codex',
          client: 'codex',
          remote: 'bob',
        }),
      ])
    );
    const remote = await row('agent:bob/codex');
    expect(within(remote).getByText('remote: bob')).toBeTruthy();
    expect(
      within(remote).getByRole('button', { name: 'Mute agent:bob/codex' })
    ).toBeTruthy();
    expect(
      within(remote).queryByRole('button', { name: /Approve/ })
    ).toBeNull();
    expect(within(remote).queryByRole('button', { name: /Revoke/ })).toBeNull();
  });
});
