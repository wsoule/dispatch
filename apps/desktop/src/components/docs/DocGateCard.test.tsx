import type { DocProposalView } from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, mock } from 'bun:test';

import type { DecideAvailability } from '../../lib/daemonAuth';
import { DocGateCard } from './DocGateCard';

const CAN_DECIDE: DecideAvailability = {
  enabled: true,
  notice: null,
  explanation: null,
  restart: null,
};

function view(
  mergeable: { clean: boolean; headN: number },
  state: DocProposalView['proposal']['state'] = 'open'
): DocProposalView {
  return {
    proposal: { rev: 'rev-p', author: 'run:r-1', state },
    title: 'Auth spec',
    body: 'new\n',
    chunks: [
      { equal: true, a: ['same\n'], b: ['same\n'] },
      { equal: false, a: ['old\n'], b: ['new\n'] },
    ],
    mergeable,
  } as DocProposalView;
}

function renderCard(read: DocProposalView) {
  const load = mock((_rev: string) => Promise.resolve(read));
  const onDecide = mock((_choice: 'approve' | 'reject', _body: string) =>
    Promise.resolve()
  );
  const onOpenDoc = mock((_doc: string, _proposal: string) => undefined);
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <DocGateCard
        doc="doc-1"
        proposal="rev-p"
        client={{ getDocProposal: load }}
        port={1}
        availability={CAN_DECIDE}
        onRestartDaemon={() => Promise.resolve()}
        onDecide={onDecide}
        onOpenDoc={onOpenDoc}
      />
    </QueryClientProvider>
  );
  return { load, onDecide, onOpenDoc };
}

describe('DocGateCard', () => {
  it('shows the title, the proposer, the diff and "merges cleanly", then approves', async () => {
    const { load, onDecide } = renderCard(view({ clean: true, headN: 3 }));
    expect(
      screen.getByRole('radio', { name: 'Approve' }).hasAttribute('disabled')
    ).toBe(true);
    expect(await screen.findByText('Auth spec')).toBeTruthy();
    expect(load).toHaveBeenCalledWith('rev-p');
    expect(screen.getByText(/run:r-1/)).toBeTruthy();
    expect(screen.getByText('merges cleanly')).toBeTruthy();
    expect(screen.getByText('-old')).toBeTruthy();
    expect(screen.getByText('+new')).toBeTruthy();
    expect(screen.queryByText(/same/)).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Approve' }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith('approve', ''));
  });

  it('offers only Reject and the merge view when the proposal conflicts', async () => {
    const { onDecide, onOpenDoc } = renderCard(
      view({ clean: false, headN: 4 })
    );
    expect(await screen.findByText('conflicts with rev 4')).toBeTruthy();
    expect(screen.queryByRole('radio', { name: 'Approve' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open merge view' }));
    expect(onOpenDoc).toHaveBeenCalledWith('doc-1', 'rev-p');
    fireEvent.click(screen.getByRole('radio', { name: 'Reject' }));
    await waitFor(() =>
      expect(onDecide).toHaveBeenCalledWith('reject', 'resolved in the doc')
    );
  });

  it('rejects a conflicting proposal with the reason typed rather than the fixed one', async () => {
    const { onDecide } = renderCard(view({ clean: false, headN: 4 }));
    await screen.findByText('conflicts with rev 4');
    fireEvent.change(screen.getByLabelText('Reason (optional)'), {
      target: { value: 'superseded by rev 4' },
    });
    fireEvent.click(screen.getByRole('radio', { name: 'Reject' }));
    await waitFor(() =>
      expect(onDecide).toHaveBeenCalledWith('reject', 'superseded by rev 4')
    );
  });

  it('rejects with the reason typed, when one is', async () => {
    const { onDecide } = renderCard(view({ clean: true, headN: 3 }));
    await screen.findByText('Auth spec');
    fireEvent.change(screen.getByLabelText('Reason (optional)'), {
      target: { value: 'out of scope' },
    });
    fireEvent.click(screen.getByRole('radio', { name: 'Reject' }));
    await waitFor(() =>
      expect(onDecide).toHaveBeenCalledWith('reject', 'out of scope')
    );
  });

  it('says a proposal that is no longer open was decided, and offers nothing', async () => {
    renderCard(view({ clean: true, headN: 3 }, 'approved'));
    expect(await screen.findByText('Already approved.')).toBeTruthy();
    expect(
      screen.getByRole('radio', { name: 'Approve' }).hasAttribute('disabled')
    ).toBe(true);
  });
});
