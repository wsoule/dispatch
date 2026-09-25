import type { ReceiptsStatus } from '@dispatch/client';
import type { ConfigPatch } from '@dispatch/core/browser';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { argvFromLines, CliAgents } from './AgentsMoreGroups';
import {
  boardStorage,
  BoardSyncSettings,
  CommitTaskFilesGroup,
  DaemonConfigGroups,
  ownRepoPatch,
  receiptsPlacePatch,
  syncPlacePatch,
} from './DaemonConfigGroups';
import { OPERATOR_ONLY } from './fields';
import { testConfig as config } from './fixtures.test-helper';
import { PreviewsSection } from './PreviewsSection';
import { moved, StatusesGroup, VerifyStepsList } from './ProjectGroups';
import { QueueWeightsGroup } from './QueueWeightsGroup';
import {
  describeRemote,
  remoteFromForm,
  RemotesSection,
} from './RemotesSection';

// The settings that used to live only in config.yml: each control sends the
// patch the daemon expects, and the ones that run a command or send data
// elsewhere are read-only to anyone below the operator tier.

function recorder() {
  const saved: ConfigPatch[] = [];
  return {
    saved,
    onSave: (p: ConfigPatch) => Promise.resolve(void saved.push(p)),
  };
}

function type(label: string, value: string) {
  const input = screen.getByLabelText(label);
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

test('previews: the dev command saves on blur', () => {
  const r = recorder();
  render(<PreviewsSection config={config} onSave={r.onSave} canOperate />);
  type('Start command', 'pnpm dev --port $PORT');
  expect(r.saved).toEqual([{ preview: { command: 'pnpm dev --port $PORT' } }]);
});

test('previews: emptying a saved command sends null, restoring autodetect', () => {
  const r = recorder();
  render(
    <PreviewsSection
      config={{
        ...config,
        preview: {
          enabled: true,
          command: 'pnpm dev',
          readyTimeoutSec: 90,
          idleTimeoutSec: 600,
        },
      }}
      onSave={r.onSave}
      canOperate
    />
  );
  type('Start command', '');
  expect(r.saved).toEqual([{ preview: { command: null } }]);
});

test('previews: below the operator tier the commands are read-only', () => {
  const r = recorder();
  render(
    <PreviewsSection config={config} onSave={r.onSave} canOperate={false} />
  );
  expect(screen.queryByRole('textbox', { name: 'Start command' })).toBeNull();
  // The reason is the lock's accessible name, not a printed sentence.
  expect(screen.getAllByLabelText(OPERATOR_ONLY).length).toBeGreaterThan(0);
  expect(screen.queryByText(OPERATOR_ONLY)).toBeNull();
});

test('remotes: a filled form adds one, and only a real port is accepted', () => {
  expect(
    remoteFromForm({
      host: ' box ',
      user: '',
      port: '22x',
      path: '',
      identityFile: '',
    })
  ).toBeNull();
  expect(
    describeRemote({ host: 'box', user: 'ci', port: 2222, path: '/srv/r' })
  ).toBe('ci@box:2222  /srv/r');

  const r = recorder();
  render(<RemotesSection config={config} onSave={r.onSave} canOperate />);
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'box' } });
  fireEvent.change(screen.getByLabelText('Host'), {
    target: { value: 'build-box' },
  });
  fireEvent.change(screen.getByLabelText('Checkout path'), {
    target: { value: '/srv/repo' },
  });
  fireEvent.click(screen.getByRole('button', { name: /Add machine/ }));
  expect(r.saved).toEqual([
    { remotes: { box: { host: 'build-box', path: '/srv/repo' } } },
  ]);
});

test('statuses: a new one goes before the last, and they reorder and remove', () => {
  expect(moved(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
  expect(moved(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);

  const r = recorder();
  const statuses = ['draft', 'ready', 'landed'];
  render(<StatusesGroup config={{ ...config, statuses }} onSave={r.onSave} />);
  fireEvent.change(screen.getByLabelText('Add a column'), {
    target: { value: 'QA' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  fireEvent.click(screen.getByRole('button', { name: 'Move ready up' }));
  fireEvent.click(screen.getByRole('button', { name: 'Remove draft' }));
  expect(r.saved).toEqual([
    { statuses: ['draft', 'ready', 'qa', 'landed'] },
    { statuses: ['ready', 'draft', 'landed'] },
    { statuses: ['ready', 'landed'] },
  ]);
});

test('verify steps: added in order, and removing the last clears the list', () => {
  const r = recorder();
  render(
    <VerifyStepsList
      config={{
        ...config,
        verifySteps: [{ name: 'types', command: 'pnpm typecheck' }],
      }}
      onSave={r.onSave}
      canOperate
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Remove types' }));
  expect(r.saved).toEqual([{ verifySteps: null }]);
});

test('agents: a CLI agent is declared from one argument per line', () => {
  expect(argvFromLines('gemini\n  -p \n\n{prompt}\n')).toEqual([
    'gemini',
    '-p',
    '{prompt}',
  ]);
  const r = recorder();
  render(<CliAgents config={config} onSave={r.onSave} canOperate />);
  fireEvent.change(screen.getByLabelText('Agent name'), {
    target: { value: 'gemini' },
  });
  fireEvent.change(screen.getByLabelText('Command, one argument per line'), {
    target: { value: 'gemini\n-p\n{prompt}' },
  });
  fireEvent.change(screen.getByLabelText('Model for coding runs'), {
    target: { value: 'gemini-2.5-pro' },
  });
  fireEvent.click(screen.getByRole('button', { name: /Add agent/ }));
  expect(r.saved).toEqual([
    {
      executors: {
        gemini: {
          command: { run: ['gemini', '-p', '{prompt}'] },
          models: { execute: 'gemini-2.5-pro' },
        },
      },
    },
  ]);
});

test('where sync and receipts go: nothing is written until there is somewhere to write', () => {
  // A repo of its own waits for its URL.
  expect(syncPlacePatch('repo', {})).toBeNull();
  expect(syncPlacePatch('remote', { repo: 'x' })).toEqual({ repo: null });
  expect(syncPlacePatch('remote', {})).toBeNull();
  // Entering one writes it alone, never beside a remote.
  expect(ownRepoPatch('git@x:y.git')).toEqual({
    remote: null,
    repo: 'git@x:y.git',
  });
  expect(receiptsPlacePatch('off', { remote: 'origin' })).toEqual({
    remote: null,
    repo: null,
  });
  expect(receiptsPlacePatch('off', {})).toBeNull();
  expect(receiptsPlacePatch('remote', {})).toEqual({
    repo: null,
    remote: 'origin',
  });
  expect(receiptsPlacePatch('repo', { remote: 'origin' })).toBeNull();
});

test('daemon: the digest cooldown saves; the receipt folder is the owner’s', () => {
  const r = recorder();
  render(
    <DaemonConfigGroups config={config} onSave={r.onSave} canOperate={false} />
  );
  type('Refresh the summary at most every', '12');
  expect(r.saved).toEqual([{ repoDigest: { cooldownHours: 12 } }]);
  expect(screen.queryByRole('textbox', { name: 'Folder' })).toBeNull();
});

// Whether the log is kept is the audit trail, and it is pushed with the
// owner's own git credentials, so the switch and the branch are theirs too.
test('daemon: keeping the receipt log and its branch are the owner’s', () => {
  render(
    <DaemonConfigGroups
      config={{ ...config, receipts: { enabled: true, remote: 'origin' } }}
      onSave={() => Promise.resolve()}
      canOperate={false}
    />
  );
  expect(
    screen
      .getByRole('switch', { name: 'Keep a receipt log' })
      .hasAttribute('data-disabled')
  ).toBe(true);
  expect(screen.queryByRole('textbox', { name: 'Branch' })).toBeNull();
});

test('board sync: the interval saves; where the board is kept is the owner’s', () => {
  const r = recorder();
  render(
    <BoardSyncSettings config={config} onSave={r.onSave} canOperate={false} />
  );
  type("Check for teammates' changes every", '60');
  expect(r.saved).toEqual([{ sync: { intervalSec: 60 } }]);
  expect(screen.queryByRole('textbox', { name: 'Remote' })).toBeNull();
  expect(screen.getAllByLabelText(OPERATOR_ONLY).length).toBeGreaterThan(0);
});

// Turning sharing on pushes the board with the owner's git credentials, to
// origin unless they chose otherwise, and the branch is where it lands.
test('board sync: turning sharing on and its branch are the owner’s', () => {
  render(
    <BoardSyncSettings
      config={config}
      onSave={() => Promise.resolve()}
      canOperate={false}
    />
  );
  expect(
    screen
      .getByRole('switch', { name: 'Share this board with teammates' })
      .hasAttribute('data-disabled')
  ).toBe(true);
  expect(screen.queryByRole('textbox', { name: 'Branch' })).toBeNull();
});

// Sharing never depended on autoCommit, which only drives a board kept as
// files; a database-backed board's sharing settings don't offer it.
test('board sync: sharing does not ask to commit task files', () => {
  render(
    <BoardSyncSettings
      config={config}
      onSave={() => Promise.resolve()}
      canOperate
    />
  );
  expect(
    screen.getByRole('switch', { name: 'Share this board with teammates' })
  ).toBeDefined();
  expect(screen.queryByRole('switch', { name: /Commit task/ })).toBeNull();
});

// GET /api/sync's receipt log, which is off exactly on a board kept as files.
function receipts(state: ReceiptsStatus['state']): {
  receipts: ReceiptsStatus;
} {
  return {
    receipts: {
      state,
      detail: null,
      commit: null,
      changed: 0,
      removed: 0,
      problems: 0,
      lastExportedAt: null,
    },
  };
}

test('board sync: how the board is kept comes from health, else the receipt log', () => {
  expect(boardStorage({ storageBackend: 'files' }, null)).toBe('files');
  // Health wins when it says.
  expect(boardStorage({ storageBackend: 'sqlite' }, receipts('disabled'))).toBe(
    'sqlite'
  );
  // An older daemon doesn't say, or health hasn't loaded: the receipt log does.
  expect(boardStorage({}, receipts('disabled'))).toBe('files');
  expect(boardStorage({}, receipts('idle'))).toBe('sqlite');
  expect(boardStorage(undefined, receipts('disabled'))).toBe('files');
});

test('board sync: until either says, how the board is kept is unknown', () => {
  expect(boardStorage(undefined, null)).toBeNull();
  expect(boardStorage({}, null)).toBeNull();
});

// Auto-commit is a row whose title labels an indigo `Switch`, not a checkbox.
test('task files: auto-commit renders as a switch named by its row title', () => {
  render(
    <CommitTaskFilesGroup
      config={config}
      onSave={() => Promise.resolve()}
      syncStatus={null}
      canOperate
    />
  );
  const toggle = screen.getByRole('switch', {
    name: 'Commit task files to the main branch',
  });
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect(screen.getByText("Sharing isn't available")).toBeDefined();
  expect(screen.queryByText('No main branch to commit to')).toBeNull();
});

// The committer needs a branch resolved at boot; without one the switch alone
// would promise commits that never happen.
test('task files: with no main branch, it says so and what to do', () => {
  render(
    <CommitTaskFilesGroup
      config={{ ...config, autoCommit: true }}
      onSave={() => Promise.resolve()}
      syncStatus={{
        state: 'disabled',
        detail: null,
        pushed: 0,
        pulled: 0,
        pendingOutgoing: 0,
        pendingIncoming: 0,
        lastSyncedAt: null,
        mergeDriverWarning: null,
        ...receipts('disabled'),
      }}
      canOperate
    />
  );
  expect(screen.getByText('No main branch to commit to')).toBeDefined();
  expect(screen.getByText(/Add one, then restart Dispatch/)).toBeDefined();
});

// Clicking the title, not just the switch, is the hit target people actually
// use — that only works if the title stays a real <label> for the switch.
test('task files: clicking the auto-commit title toggles and saves', () => {
  const r = recorder();
  render(
    <CommitTaskFilesGroup
      config={config}
      onSave={r.onSave}
      syncStatus={null}
      canOperate
    />
  );
  fireEvent.click(screen.getByText('Commit task files to the main branch'));
  expect(r.saved).toEqual([{ autoCommit: true }]);
});

// It pushes to the repo's main branch with the owner's git credentials.
test('task files: committing to the main branch is the owner’s', () => {
  const r = recorder();
  render(
    <CommitTaskFilesGroup
      config={config}
      onSave={r.onSave}
      syncStatus={null}
      canOperate={false}
    />
  );
  const toggle = screen.getByRole('switch', {
    name: 'Commit task files to the main branch',
  });
  expect(toggle.hasAttribute('data-disabled')).toBe(true);
  fireEvent.click(screen.getByText('Commit task files to the main branch'));
  expect(r.saved).toEqual([]);
});

test('queue weights: each factor saves, and 0 is allowed', () => {
  const r = recorder();
  render(<QueueWeightsGroup config={config} onSave={r.onSave} />);
  type('Age', '0');
  expect(r.saved).toEqual([{ queue: { weights: { age: 0 } } }]);
});
