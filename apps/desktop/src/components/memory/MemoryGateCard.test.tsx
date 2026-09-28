import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, mock } from 'bun:test';

import type { DecideAvailability } from '../../lib/daemonAuth';
import type { ProposalRead } from '../../lib/memory';
import {
  content,
  entry,
  proposal as proposalView,
} from '../../lib/memory.test-helper';
import { MemoryGateCard } from './MemoryGateCard';

const CAN_DECIDE: DecideAvailability = {
  enabled: true,
  notice: null,
  explanation: null,
  restart: null,
};

function read(over: Partial<ProposalRead> = {}): ProposalRead {
  return { proposal: proposalView(), base: null, current: null, ...over };
}

function renderCard(
  load: (id: string) => Promise<ProposalRead>,
  availability: DecideAvailability = CAN_DECIDE
) {
  const onDecide = mock((_choice: 'approve' | 'reject') => Promise.resolve());
  const onRestartDaemon = mock(() => Promise.resolve());
  render(
    <MemoryGateCard
      proposalId="mp-000001"
      client={{ getMemoryProposal: load }}
      availability={availability}
      onRestartDaemon={onRestartDaemon}
      onDecide={onDecide}
    />
  );
  return { onDecide, onRestartDaemon };
}

describe('MemoryGateCard', () => {
  it('shows the proposal before it can be decided, then approves it', async () => {
    const load = mock((_id: string) => Promise.resolve(read()));
    const { onDecide } = renderCard(load);
    expect(
      screen.getByRole('radio', { name: 'Approve' }).hasAttribute('disabled')
    ).toBe(true);
    await screen.findByText('pnpm 11 ignores onlyBuiltDependencies');
    expect(load).toHaveBeenCalledWith('mp-000001');
    expect(screen.getByText('Save this hazard to team memory?')).toBeTruthy();
    expect(screen.getByText('Use allowBuilds.')).toBeTruthy();
    expect(
      screen.getByText(/every run in this project, and teammates’/)
    ).toBeTruthy();
    expect(screen.getByText(/run:r-9f2c01/)).toBeTruthy();
    expect(screen.getByText(/t-1a2b3c/)).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Approve' }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith('approve'));
  });

  it('rejects it', async () => {
    const { onDecide } = renderCard(() => Promise.resolve(read()));
    await screen.findByText('pnpm 11 ignores onlyBuiltDependencies');
    fireEvent.click(screen.getByRole('radio', { name: 'Reject' }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith('reject'));
  });

  it('shows a supersede as the current version beside the proposed one', async () => {
    renderCard(() =>
      Promise.resolve(
        read({
          proposal: proposalView({
            action: 'supersede',
            target: 'mem-000001',
            content: content({ body: 'the new advice' }),
          }),
          base: entry({ body: 'the old advice' }),
          current: entry({ body: 'the old advice' }),
        })
      )
    );
    expect(await screen.findByText('the old advice')).toBeTruthy();
    expect(screen.getByText('the new advice')).toBeTruthy();
    expect(screen.queryByText('Proposed against')).toBeNull();
  });

  it('shows the version proposed against beside the current one once the entry changed', async () => {
    renderCard(() =>
      Promise.resolve(
        read({
          proposal: proposalView({
            action: 'supersede',
            target: 'mem-000001',
            baseRev: 1,
            content: content({ body: 'the agent version' }),
          }),
          base: entry({ rev: 1, body: 'the old advice' }),
          current: entry({ rev: 2, body: 'a human fix' }),
        })
      )
    );
    const now = await screen.findByText('a human fix');
    expect(now.closest('[data-slot="memory-version"]')?.textContent).toContain(
      'Now'
    );
    const against = screen.getByText('the old advice');
    expect(
      against.closest('[data-slot="memory-version"]')?.textContent
    ).toContain('Proposed against');
    expect(screen.getByText('the agent version')).toBeTruthy();
    expect(screen.getByText(/changed after this was proposed/)).toBeTruthy();
  });

  it('names each version’s title, so a title-only change shows', async () => {
    renderCard(() =>
      Promise.resolve(
        read({
          proposal: proposalView({
            action: 'supersede',
            target: 'mem-000001',
            baseRev: 1,
            content: content({ body: 'the agent version' }),
          }),
          base: entry({ rev: 1, title: 'pnpm builds' }),
          current: entry({ rev: 2, title: 'pnpm 11 builds' }),
        })
      )
    );
    const against = await screen.findByText('pnpm builds');
    expect(
      against.closest('[data-slot="memory-version"]')?.textContent
    ).toContain('Proposed against');
    expect(
      screen.getByText('pnpm 11 builds').closest('[data-slot="memory-version"]')
        ?.textContent
    ).toContain('Now');
  });

  it('says approving adds a new entry once the entry was retired since', async () => {
    renderCard(() =>
      Promise.resolve(
        read({
          proposal: proposalView({
            action: 'supersede',
            target: 'mem-000001',
            baseRev: 1,
            content: content({ body: 'the agent version' }),
          }),
          base: entry({ rev: 1, body: 'the old advice' }),
          current: entry({
            rev: 2,
            body: 'the old advice',
            status: 'retired',
            statusReason: 'forgotten',
            state: 'retired',
          }),
        })
      )
    );
    const now = await screen.findByText('the old advice');
    expect(now.closest('[data-slot="memory-version"]')?.textContent).toContain(
      'Now (retired)'
    );
    expect(
      screen.getByText(/retired after this was proposed/).textContent
    ).toContain('as a new entry');
    expect(screen.queryByText(/replaces the version it has now/)).toBeNull();
  });

  it('says a personal match exists, and why a retire was asked for', async () => {
    renderCard(() =>
      Promise.resolve(
        read({
          proposal: proposalView({
            action: 'retire',
            target: 'mem-000001',
            content: null,
            reason: 'fixed upstream',
            matchedPersonal: true,
          }),
          current: entry({ title: 'pnpm builds' }),
        })
      )
    );
    expect(await screen.findByText('pnpm builds')).toBeTruthy();
    expect(screen.getByText(/fixed upstream/)).toBeTruthy();
    expect(
      screen.getByText(/matches a personal entry of the author’s operator/)
    ).toBeTruthy();
  });

  it('never decides blind: a failed load keeps both choices off and offers a retry', async () => {
    let fail = true;
    const load = mock((_id: string) =>
      fail
        ? Promise.reject(new Error('memory is unavailable'))
        : Promise.resolve(read())
    );
    const { onDecide } = renderCard(load);
    expect(await screen.findByText(/memory is unavailable/)).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Approve' }));
    expect(onDecide).not.toHaveBeenCalled();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('pnpm 11 ignores onlyBuiltDependencies');
    expect(
      screen.getByRole('radio', { name: 'Approve' }).hasAttribute('disabled')
    ).toBe(false);
  });

  it('offers nothing to decide once the proposal was decided elsewhere', async () => {
    const { onDecide } = renderCard(() =>
      Promise.resolve(read({ proposal: proposalView({ state: 'approved' }) }))
    );
    expect(await screen.findByText(/already approved/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Reject' }));
    expect(onDecide).not.toHaveBeenCalled();
  });

  it('is inert in a window that cannot decide, and says why', async () => {
    const { onDecide, onRestartDaemon } = renderCard(
      () => Promise.resolve(read()),
      {
        enabled: false,
        notice: 'Restart daemon to enable approvals',
        explanation: 'This window did not start the daemon.',
        restart: { safe: true, blockedReason: null },
      }
    );
    await screen.findByText('pnpm 11 ignores onlyBuiltDependencies');
    fireEvent.click(screen.getByRole('radio', { name: 'Approve' }));
    expect(onDecide).not.toHaveBeenCalled();
    expect(screen.getByText('Restart daemon to enable approvals')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /restart daemon/i }));
    expect(onRestartDaemon).toHaveBeenCalledTimes(1);
  });
});
