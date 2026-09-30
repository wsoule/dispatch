import type {
  EpicChildPhase,
  EpicProgress,
  EpicProgressChild,
  EpicSession,
  EpicWave,
} from '@dispatch/client';
import type { TaskDoc } from '@dispatch/core/browser';
import { DEFAULT_STATUS_MODEL } from '@dispatch/core/browser';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { FanoutControls } from './FanoutControls';

const payments = {
  meta: { id: 'e-1', title: 'Payments', status: 'working', kind: 'epic' },
  body: '',
} as unknown as TaskDoc;

function child(
  id: string,
  phase: EpicChildPhase,
  overrides: Partial<EpicProgressChild> = {}
): EpicProgressChild {
  return {
    id,
    title: id,
    status: phase === 'landed' ? 'landed' : 'working',
    phase,
    wave: 1,
    openFindings: 0,
    ...overrides,
  };
}

function sessionWith(
  state: EpicSession['state'],
  overrides: Partial<EpicSession> = {}
): EpicSession {
  return {
    epicId: 'e-1',
    concurrency: 3,
    executor: 'claude',
    state,
    maxSpendUsd: 60,
    maxRuns: 20,
    startedAt: '2026-09-20T00:00:00.000Z',
    startedBy: null,
    scope: 'plan',
    updatedAt: '2026-09-20T00:00:00.000Z',
    active: state === 'active',
    ...overrides,
  };
}

function progressWith(
  children: EpicProgressChild[],
  overrides: Partial<EpicProgress> = {}
): EpicProgress {
  return {
    epicId: 'e-1',
    active: overrides.session?.state === 'active',
    session: null,
    // $71.20 committed of $100 — under the 80 % mark, so the pill reads as working.
    spend: {
      settledUsd: 41.2,
      liveCount: 3,
      estimatedLiveUsd: 30,
      runsStarted: 7,
      maxSpendUsd: 100,
      maxRuns: 20,
    },
    children,
    waves: [],
    liveRuns: [],
    ...overrides,
  };
}

function mount(
  progress: EpicProgress | undefined,
  overrides: Partial<React.ComponentProps<typeof FanoutControls>> = {}
) {
  const calls: string[] = [];
  const record =
    (verb: string) =>
    (id: string): Promise<void> => {
      calls.push(`${verb}:${id}`);
      return Promise.resolve();
    };
  const children = progress?.children ?? [];
  const { unmount } = render(
    <FanoutControls
      epic={payments}
      model={DEFAULT_STATUS_MODEL}
      progress={progress}
      count={
        progress === undefined
          ? undefined
          : {
              done: children.filter((c) => c.phase === 'landed').length,
              total: children.length,
            }
      }
      landable={false}
      onSendAgents={(id) => {
        calls.push(`send:${id}`);
      }}
      onPause={record('pause')}
      onResume={record('resume')}
      onRaiseCeiling={(id) => {
        calls.push(`raise:${id}`);
      }}
      onStop={record('stop')}
      onLand={record('land')}
      onOpenEpic={(id) => {
        calls.push(`open:${id}`);
      }}
      {...overrides}
    />
  );
  return { calls, unmount };
}

// A verb clears its busy flag after its handler settles; drain the queue before asserting.
async function settle(work: () => void) {
  await act(async () => {
    work();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function buttonNames(): string[] {
  return screen.getAllByRole('button').map((b) => b.textContent ?? '');
}

const noSession = progressWith([
  child('t-1', 'working'),
  child('t-2', 'landed'),
]);

test('no session: ◔ done/total, the caller’s pills, Send agents… and Open', () => {
  const { calls } = mount(noSession, {
    children: <span data-slot="health">At risk</span>,
  });
  const progress = document.querySelector('[data-slot=milestone-progress]');
  expect(progress?.textContent).toBe('1/2');
  expect(progress?.getAttribute('aria-label')).toBe('1 of 2 landed');
  expect(screen.getByText('At risk')).not.toBeNull();
  expect(buttonNames()).toEqual(['Send agents…', '']);
  fireEvent.click(screen.getByRole('button', { name: 'Send agents…' }));
  fireEvent.click(screen.getByRole('button', { name: 'Open Payments' }));
  expect(calls).toEqual(['send:e-1', 'open:e-1']);
  expect(document.querySelector('[role=progressbar]')).toBeNull();
});

test('the concurrency picker only shows before a session exists', () => {
  const picker = <button type="button">3×</button>;
  const { unmount } = render(
    <FanoutControls
      epic={payments}
      model={DEFAULT_STATUS_MODEL}
      progress={noSession}
      count={{ done: 1, total: 2 }}
      landable={false}
      concurrencyPicker={picker}
      onSendAgents={() => {}}
      onStop={() => Promise.resolve()}
      onOpenEpic={() => {}}
    />
  );
  expect(screen.getByText('3×')).not.toBeNull();
  unmount();
  render(
    <FanoutControls
      epic={payments}
      model={DEFAULT_STATUS_MODEL}
      progress={progressWith([child('t-1', 'working')], {
        session: sessionWith('active'),
      })}
      count={{ done: 0, total: 1 }}
      landable={false}
      concurrencyPicker={picker}
      onSendAgents={() => {}}
      onStop={() => Promise.resolve()}
      onOpenEpic={() => {}}
    />
  );
  expect(screen.queryByText('3×')).toBeNull();
});

test('active: phase chips in order, the spend pill against its ceiling, Pause and Stop', async () => {
  const { calls } = mount(
    progressWith(
      [
        child('t-1', 'working'),
        child('t-2', 'working'),
        child('t-3', 'working'),
        child('t-4', 'queued'),
        child('t-5', 'queued'),
        child('t-6', 'capped'),
      ],
      { session: sessionWith('active') }
    )
  );
  const chips = Array.from(
    document.querySelectorAll<HTMLElement>('[data-slot=phase-chip]')
  );
  expect(chips.map((c) => c.dataset['phase'])).toEqual([
    'working',
    'queued',
    'capped',
  ]);
  expect(chips.map((c) => c.textContent)).toEqual([
    '3Working',
    '2Queued',
    '1Capped',
  ]);
  expect(chips[0]?.style.color).toBe('var(--state-working-fg)');
  expect(chips[2]?.style.color).toBe('var(--state-waiting-fg)');

  const spend = screen
    .getByText('$41.20 / $100')
    .closest('[data-slot=spend-pill]');
  expect(spend?.getAttribute('title')).toBe('+~$30.00 in flight · 7/20 runs');
  expect(
    spend
      ?.querySelector<HTMLElement>('span[aria-hidden]')
      ?.style.backgroundColor.replace(/\s/g, '')
  ).toBe('var(--state-working-fg)');
  // Three live runs, so no ruling pill and no Send agents… while it runs.
  expect(screen.queryByText(/Waiting on/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Send agents…' })).toBeNull();
  expect(buttonNames()).toEqual(['Pause', 'Stop', '']);

  await settle(() => {
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
  });
  await settle(() => {
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  });
  expect(calls).toEqual(['pause:e-1', 'stop:e-1']);
});

test('the spend pill turns amber from 80 % of the ceiling, in-flight estimate included', () => {
  mount(
    progressWith([child('t-1', 'working')], {
      session: sessionWith('active'),
      spend: {
        settledUsd: 30,
        liveCount: 2,
        estimatedLiveUsd: 20,
        runsStarted: 3,
        maxSpendUsd: 60,
        maxRuns: null,
      },
    })
  );
  const spend = screen.getByText('$30 / $60').closest('[data-slot=spend-pill]');
  // The title says what the amber dot says, for anyone who cannot see the colour.
  expect(spend?.getAttribute('title')).toBe(
    '+~$20.00 in flight · 3 runs · near ceiling'
  );
  expect(
    spend
      ?.querySelector<HTMLElement>('span[aria-hidden]')
      ?.style.backgroundColor.replace(/\s/g, '')
  ).toBe('var(--state-waiting-fg)');
});

test('active with nothing live and a capped loop: Waiting on N rulings', () => {
  const { unmount } = mount(
    progressWith([child('t-1', 'capped'), child('t-2', 'landed')], {
      session: sessionWith('active'),
      spend: {
        settledUsd: 12,
        liveCount: 0,
        estimatedLiveUsd: 0,
        runsStarted: 2,
        maxSpendUsd: 60,
        maxRuns: 20,
      },
    })
  );
  expect(screen.getByText('Waiting on 1 ruling')).not.toBeNull();
  unmount();
  mount(
    progressWith([child('t-1', 'capped'), child('t-2', 'capped')], {
      session: sessionWith('active'),
      spend: {
        settledUsd: 12,
        liveCount: 0,
        estimatedLiveUsd: 0,
        runsStarted: 2,
        maxSpendUsd: null,
        maxRuns: null,
      },
    })
  );
  expect(screen.getByText('Waiting on 2 rulings')).not.toBeNull();
  expect(screen.getByText('$12')).not.toBeNull();
});

test('a multi-wave session shows a wave strip; a single wave does not', () => {
  const waves: EpicWave[] = [
    { index: 1, total: 2, byPhase: { landed: 2 } },
    { index: 2, total: 1, byPhase: { working: 1 } },
    { index: 3, total: 1, byPhase: { queued: 1 } },
  ];
  const { unmount } = mount(
    progressWith([child('t-1', 'working')], {
      session: sessionWith('active'),
      waves,
    })
  );
  const strip = document.querySelector('ol');
  expect(strip?.className).toContain('w-16');
  expect(
    Array.from(strip?.querySelectorAll('li') ?? []).map((li) =>
      li.getAttribute('title')
    )
  ).toEqual(['Wave 1 · passed', 'Wave 2 · active', 'Wave 3 · pending']);
  unmount();
  mount(
    progressWith([child('t-1', 'working')], {
      session: sessionWith('active'),
      waves: waves.slice(0, 1),
    })
  );
  expect(document.querySelector('ol')).toBeNull();
});

test('paused: the spend pill, the reason pill with its detail, Resume, Raise ceiling… and Stop', async () => {
  const { calls } = mount(
    progressWith([child('t-1', 'queued')], {
      session: sessionWith('paused', {
        pausedReason: 'budget',
        pausedDetail: '$60.00 settled of $60.00',
      }),
      spend: {
        settledUsd: 60,
        liveCount: 0,
        estimatedLiveUsd: 0,
        runsStarted: 7,
        maxSpendUsd: 60,
        maxRuns: 20,
      },
    })
  );
  // The ceiling that tripped sits next to Raise ceiling….
  const spend = screen.getByText('$60 / $60').closest('[data-slot=spend-pill]');
  expect(spend?.getAttribute('title')).toBe('7/20 runs · near ceiling');
  const pill = screen
    .getByText('Paused — budget ceiling')
    .closest('[data-slot=paused-pill]');
  expect(pill?.getAttribute('title')).toBe('$60.00 settled of $60.00');
  expect(buttonNames()).toEqual(['Resume', 'Raise ceiling…', 'Stop', '']);
  await settle(() => {
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
  });
  fireEvent.click(screen.getByRole('button', { name: 'Raise ceiling…' }));
  await settle(() => {
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  });
  expect(calls).toEqual(['resume:e-1', 'raise:e-1', 'stop:e-1']);
});

test('every pause reason has its own label', () => {
  for (const [reason, label] of [
    ['runs', 'Paused — run ceiling'],
    ['human', 'Paused — by you'],
    ['fill-failed', 'Paused — auto-dispatch failed'],
  ] as const) {
    const { unmount } = mount(
      progressWith([child('t-1', 'queued')], {
        session: sessionWith('paused', { pausedReason: reason }),
      })
    );
    expect(screen.getByText(label)).not.toBeNull();
    unmount();
  }
});

test('landable: Land replaces Send agents… once every child is done', async () => {
  const { calls } = mount(
    progressWith([child('t-1', 'landed'), child('t-2', 'landed')], {
      session: sessionWith('complete'),
    }),
    { landable: true }
  );
  expect(buttonNames()).toEqual(['Land', '']);
  await settle(() => {
    fireEvent.click(screen.getByRole('button', { name: 'Land' }));
  });
  expect(calls).toEqual(['land:e-1']);
});

test('a finished session that is not landable offers Send agents… again', () => {
  mount(
    progressWith([child('t-1', 'failed'), child('t-2', 'landed')], {
      session: sessionWith('stopped'),
    })
  );
  expect(buttonNames()).toEqual(['Send agents…', '']);
  expect(document.querySelector('[data-slot=phase-chip]')).toBeNull();
});

test('no progress yet: no glyph, still Send agents… and Open', () => {
  mount(undefined);
  expect(document.querySelector('[data-slot=milestone-progress]')).toBeNull();
  expect(buttonNames()).toEqual(['Send agents…', '']);
});

test('an empty milestone reads ◔ 0/0 and has nothing to send', () => {
  mount(undefined, { count: { done: 0, total: 0 } });
  const progress = document.querySelector('[data-slot=milestone-progress]');
  expect(progress?.textContent).toBe('0/0');
  expect(progress?.getAttribute('aria-label')).toBe('0 of 0 landed');
  expect(buttonNames()).toEqual(['']);
});

test('a landed epic offers no verb at all', () => {
  mount(noSession, {
    epic: {
      ...payments,
      meta: { ...payments.meta, status: 'landed' },
    } as TaskDoc,
  });
  expect(
    document.querySelector('[data-slot=milestone-progress]')
  ).not.toBeNull();
  expect(buttonNames()).toEqual(['']);
});

test('showOpen=false drops the trailing Open button for a caller with its own', () => {
  mount(noSession, { showOpen: false });
  expect(screen.queryByRole('button', { name: 'Open Payments' })).toBeNull();
  expect(buttonNames()).toEqual(['Send agents…']);
});

test('a verb disables the row while it runs and shows a rejected handler’s message', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  mount(
    progressWith([child('t-1', 'working')], { session: sessionWith('active') }),
    {
      onPause: () => gate,
      onStop: () => Promise.reject(new Error('session is not active')),
    }
  );
  await settle(() => {
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
  });
  expect(
    screen.getByRole('button', { name: 'Stop' }).hasAttribute('disabled')
  ).toBe(true);
  await settle(() => release());
  expect(
    screen.getByRole('button', { name: 'Stop' }).hasAttribute('disabled')
  ).toBe(false);

  await settle(() => {
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  });
  const alert = screen.getByRole('alert');
  expect(alert.textContent).toBe('session is not active');
  expect(alert.getAttribute('title')).toBe('session is not active');
});

test('phases={false} drops the chips and keeps the verbs', () => {
  mount(
    progressWith([child('t-1', 'working'), child('t-2', 'queued')], {
      session: sessionWith('active'),
    }),
    { phases: false }
  );
  expect(document.querySelector('[data-slot=phase-chip]')).toBeNull();
  expect(screen.getByRole('button', { name: 'Pause' })).not.toBeNull();
});

test('waves={false} drops the wave strip and keeps the verbs', () => {
  const waves = [
    { index: 1, total: 2, byPhase: { landed: 2 } },
    { index: 2, total: 1, byPhase: { working: 1 } },
  ];
  const active = progressWith([child('t-1', 'working')], {
    session: sessionWith('active'),
    waves,
  });
  const { unmount } = mount(active);
  expect(document.querySelector('ol')).not.toBeNull();
  unmount();
  mount(active, { waves: false });
  expect(document.querySelector('ol')).toBeNull();
  expect(screen.getByRole('button', { name: 'Pause' })).not.toBeNull();
});
