import { ApiError } from '@dispatch/client';
import type {
  LinearAccountView,
  LinearSignInProblemCode,
} from '@dispatch/client';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { useState } from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import {
  LINEAR_SIGN_IN_TAB_BLOCKED,
  LINEAR_SIGN_IN_URL_REFUSED,
} from '../../lib/linearSignIn';
import {
  accessFor,
  ATTACHED_READ_ONLY,
  OPERATOR_ONLY,
  SettingsAccessProvider,
} from './access';
import { dataWith, testConfig } from './fixtures.test-helper';
import {
  LINEAR_NOT_REVOKED,
  LINEAR_READ_ONLY_GRANT,
  LINEAR_SIGN_IN_TEAMMATE,
  LINEAR_SIGN_IN_UNCONFIGURED,
  LINEAR_SIGNED_IN_SCOPE,
  LINEAR_STORED_SIGN_IN,
  LinearAccountGroup,
} from './LinearAccount';
import { LinearPanel } from './LinearPanel';

const AUTHORIZE_URL =
  'https://linear.app/oauth/authorize?client_id=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A47823%2Flinear%2Fcallback&response_type=code&scope=read%2Cwrite&state=s&code_challenge=c&code_challenge_method=S256';

const WORKSPACE = { id: 'org-1', name: 'Acme', urlKey: 'acme' };
const CONNECTION = {
  userId: 'u-bot',
  userName: 'Bot User',
  workspace: WORKSPACE,
};

/** The owner's view of a configured, connected project nobody signed in to. */
const SIGNED_OUT: LinearAccountView = {
  canSignIn: true,
  unavailable: null,
  callbackUrl: 'http://127.0.0.1:47823/linear/callback',
  clientIdSource: 'config',
  pending: false,
  account: null,
  stored: [],
  connection: CONNECTION,
  problem: null,
};

const ACCOUNT: NonNullable<LinearAccountView['account']> = {
  userId: 'u-ada',
  name: 'Ada Lovelace',
  displayName: 'ada',
  email: 'ada@example.com',
  guest: false,
  admin: false,
  canWrite: true,
  workspace: WORKSPACE,
  signedInAt: '2026-11-05T10:00:00.000Z',
};

const SIGNED_IN: LinearAccountView = { ...SIGNED_OUT, account: ACCOUNT };

/** A view nobody but the server would build: no button, no identity. */
function unavailable(
  reason: NonNullable<LinearAccountView['unavailable']>
): LinearAccountView {
  return {
    ...SIGNED_OUT,
    canSignIn: false,
    unavailable: reason,
    connection: null,
    clientIdSource: reason === 'not-configured' ? null : 'config',
  };
}

// The sign-in handlers a test can watch; each gives a happy answer.
function handlers() {
  return {
    handleLinearSignIn: mock((_opts?: { anotherWorkspace?: boolean }) =>
      Promise.resolve({ authorizeUrl: AUTHORIZE_URL })
    ),
    handleCancelLinearSignIn: mock(() => Promise.resolve()),
    handleLinearSignOut: mock((_opts?: { workspaceId?: string }) =>
      Promise.resolve({ revoked: true })
    ),
    handleUpdateConfig: mock((_patch: unknown) => Promise.resolve()),
  };
}

function renderGroup(
  view: LinearAccountView | null,
  extra: Partial<DispatchProjectData> = {},
  access = accessFor('operator', false)
) {
  const h = handlers();
  render(
    <SettingsAccessProvider access={access}>
      <LinearAccountGroup
        data={dataWith({ linearAccount: view, ...h, ...extra })}
      />
    </SettingsAccessProvider>
  );
  return h;
}

// A tab the browser UI opened: records where it was sent and whether it closed.
function stubTab() {
  const replace = mock((_url: string) => undefined);
  const close = mock(() => undefined);
  const tab = { opener: window as Window | null, location: { replace }, close };
  const open = mock((_url?: string, _target?: string) => tab);
  window.open = open as unknown as typeof window.open;
  return { tab, open, replace, close };
}

const realOpen = window.open;
beforeEach(() => {
  window.open = realOpen;
});
afterEach(() => {
  window.open = realOpen;
});

// ---- not configured: the one-time setup --------------------------------

test('unconfigured: explains the setup and the dialog shows the callback URL to register', async () => {
  renderGroup(unavailable('not-configured'));
  expect(
    screen.getByText(
      'Sign in with Linear needs a one-time setup by a Linear workspace admin.'
    )
  ).toBeDefined();
  expect(
    screen.queryByRole('button', { name: 'Sign in with Linear' })
  ).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Set up sign-in' }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText('Set up Linear sign-in')).toBeDefined();
  expect(within(dialog).getByTestId('linear-callback-url').textContent).toBe(
    'http://127.0.0.1:47823/linear/callback'
  );
  expect(within(dialog).getByText(/do not paste it anywhere/)).toBeDefined();
});

test('setup saves the client ID and callback port through config', async () => {
  const h = renderGroup(unavailable('not-configured'));
  fireEvent.click(screen.getByRole('button', { name: 'Set up sign-in' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('Client ID'), {
    target: { value: '  0f1e2d3c4b5a  ' },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(h.handleUpdateConfig).toHaveBeenCalledTimes(1));
  expect(h.handleUpdateConfig.mock.calls[0]?.[0]).toEqual({
    linear: { oauthClientId: '0f1e2d3c4b5a', oauthCallbackPort: 47823 },
  });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

test('setup refuses a bad client ID or port and says why', async () => {
  const h = renderGroup(unavailable('not-configured'));
  fireEvent.click(screen.getByRole('button', { name: 'Set up sign-in' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  expect(
    await within(dialog).findByText(/Paste the client ID from Linear/)
  ).toBeDefined();
  fireEvent.change(within(dialog).getByLabelText('Client ID'), {
    target: { value: 'has space' },
  });
  // The port fold opens; a port under 1024 is refused, and the URL follows it.
  fireEvent.click(
    within(dialog).getByRole('button', { name: /Callback port/ })
  );
  fireEvent.change(within(dialog).getByLabelText('Callback port'), {
    target: { value: '80' },
  });
  expect(
    within(dialog).getByText('Use a whole number from 1024 to 65535.')
  ).toBeDefined();
  expect(
    within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Save' })
      .disabled
  ).toBe(true);
  fireEvent.change(within(dialog).getByLabelText('Callback port'), {
    target: { value: '51000' },
  });
  expect(within(dialog).getByTestId('linear-callback-url').textContent).toBe(
    'http://127.0.0.1:51000/linear/callback'
  );
  expect(h.handleUpdateConfig).not.toHaveBeenCalled();
});

test('setup is locked for someone who may not change operator settings', async () => {
  const h = renderGroup(
    unavailable('not-configured'),
    {},
    accessFor('decide', false)
  );
  fireEvent.click(screen.getByRole('button', { name: 'Set up sign-in' }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText(OPERATOR_ONLY)).toBeDefined();
  expect(
    within(dialog).getByLabelText<HTMLInputElement>('Client ID').disabled
  ).toBe(true);
  const save = within(dialog).getByRole<HTMLButtonElement>('button', {
    name: 'Save',
  });
  expect(save.disabled).toBe(true);
  fireEvent.click(save);
  expect(h.handleUpdateConfig).not.toHaveBeenCalled();
});

test('a client ID from the environment is read-only and Save keeps it out of config', async () => {
  const h = renderGroup({ ...SIGNED_OUT, clientIdSource: 'env' });
  expect(
    screen.getByText(/The client ID comes from DISPATCH_LINEAR_CLIENT_ID/)
  ).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Edit setup' }));
  const dialog = await screen.findByRole('dialog');
  expect(
    within(dialog).getByText('Set by DISPATCH_LINEAR_CLIENT_ID.')
  ).toBeDefined();
  expect(
    within(dialog).getByLabelText<HTMLInputElement>('Client ID').readOnly
  ).toBe(true);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(h.handleUpdateConfig).toHaveBeenCalledTimes(1));
  expect(h.handleUpdateConfig.mock.calls[0]?.[0]).toEqual({
    linear: { oauthCallbackPort: 47823 },
  });
});

test('Edit setup opens on the saved client ID and port', async () => {
  renderGroup(SIGNED_OUT, {
    config: {
      ...testConfig,
      linear: {
        ...testConfig.linear,
        oauthClientId: 'saved-client',
        oauthCallbackPort: 52000,
      },
    },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Edit setup' }));
  const dialog = await screen.findByRole('dialog');
  expect(
    within(dialog).getByLabelText<HTMLInputElement>('Client ID').value
  ).toBe('saved-client');
  expect(
    within(dialog).getByLabelText<HTMLInputElement>('Callback port').value
  ).toBe('52000');
});

// ---- signed out: starting a sign-in ------------------------------------

test('signed out: says whose name changes carry until then, and signs in through the browser', async () => {
  const { open, replace, tab, close } = stubTab();
  const h = renderGroup(SIGNED_OUT);
  expect(
    screen.getByText(
      'Sign in so the changes you make here reach Linear as you. Until then they go as Bot User.'
    )
  ).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Sign in with Linear' }));
  // The tab opens inside the click, before the daemon answers.
  expect(open).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(replace).toHaveBeenCalledTimes(1));
  expect(h.handleLinearSignIn.mock.calls[0]?.[0]).toBeUndefined();
  expect(replace.mock.calls[0]?.[0]).toBe(AUTHORIZE_URL);
  expect(tab.opener).toBeNull();
  expect(close).not.toHaveBeenCalled();
  expect(h.handleCancelLinearSignIn).not.toHaveBeenCalled();
});

test('without a known connection user the copy names the project connection', () => {
  renderGroup({ ...SIGNED_OUT, connection: null });
  expect(
    screen.getByText(/Until then they go through the project connection\./)
  ).toBeDefined();
});

test('a URL that is not Linear’s opens nothing and stops the daemon waiting', async () => {
  const { replace, close } = stubTab();
  const h = renderGroup(SIGNED_OUT, {
    handleLinearSignIn: mock(() =>
      Promise.resolve({
        authorizeUrl: 'https://evil.example/oauth/authorize?state=s',
      })
    ),
  });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in with Linear' }));
  const line = await screen.findByText(LINEAR_SIGN_IN_URL_REFUSED);
  expect(line.getAttribute('data-tone')).toBe('danger');
  expect(replace).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(1);
  await waitFor(() =>
    expect(h.handleCancelLinearSignIn).toHaveBeenCalledTimes(1)
  );
});

test('a blocked tab says so and starts nothing', async () => {
  window.open = mock(() => null) as unknown as typeof window.open;
  const h = renderGroup(SIGNED_OUT);
  fireEvent.click(screen.getByRole('button', { name: 'Sign in with Linear' }));
  const line = await screen.findByText(LINEAR_SIGN_IN_TAB_BLOCKED);
  expect(line.getAttribute('data-tone')).toBe('warning');
  expect(h.handleLinearSignIn).not.toHaveBeenCalled();
});

test('a busy callback port reads as a warning and closes the reserved tab', async () => {
  const { close } = stubTab();
  const message =
    'Port 47823 is in use, so Dispatch cannot hear back from Linear. Finish or cancel the other sign-in, or change the callback port in setup (and in Linear).';
  renderGroup(SIGNED_OUT, {
    handleLinearSignIn: mock(() =>
      Promise.reject(new ApiError(message, 409, 'linear_callback_port_busy'))
    ),
  });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in with Linear' }));
  const line = await screen.findByText(message);
  expect(line.getAttribute('data-tone')).toBe('warning');
  expect(close).toHaveBeenCalledTimes(1);
});

test('any other refused start reads as a failure', async () => {
  stubTab();
  renderGroup(SIGNED_OUT, {
    handleLinearSignIn: mock(() =>
      Promise.reject(
        new ApiError(
          'Linear sign-in is only for the person running Dispatch on this computer.',
          403,
          'linear_sign_in_owner_only'
        )
      )
    ),
  });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in with Linear' }));
  const line = await screen.findByText(/only for the person running Dispatch/);
  expect(line.getAttribute('data-tone')).toBe('danger');
});

// ---- pending -----------------------------------------------------------

test('pending: asks to finish in the browser and Cancel stops waiting', async () => {
  const h = renderGroup({ ...SIGNED_OUT, pending: true });
  expect(screen.getByText('Finish signing in in your browser.')).toBeDefined();
  expect(
    screen.queryByRole('button', { name: 'Sign in with Linear' })
  ).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await waitFor(() =>
    expect(h.handleCancelLinearSignIn).toHaveBeenCalledTimes(1)
  );
});

// ---- signed in ---------------------------------------------------------

test('signed in: names the person, their email and workspace, and what reaches Linear as them', () => {
  renderGroup(SIGNED_IN);
  expect(
    screen.getByText('Signed in as Ada Lovelace (ada@example.com) in Acme')
  ).toBeDefined();
  expect(screen.getByText(LINEAR_SIGNED_IN_SCOPE)).toBeDefined();
  // A different Linear user from the connection's: assignments still map there.
  expect(
    screen.getByText('Tasks assigned to you still map to Bot User in Linear.')
  ).toBeDefined();
  expect(screen.queryByText('Guest')).toBeNull();
  expect(screen.queryByText(LINEAR_READ_ONLY_GRANT)).toBeNull();
  expect(screen.getByRole('button', { name: 'Sign out' })).toBeDefined();
  expect(screen.queryByRole('button', { name: 'Edit setup' })).toBeNull();
});

test('signed in as the connection’s own user: no mapping note', () => {
  renderGroup({
    ...SIGNED_IN,
    connection: { ...CONNECTION, userId: ACCOUNT.userId },
  });
  expect(screen.queryByText(/Tasks assigned to you still map/)).toBeNull();
});

test('a guest gets a Guest chip, and a read-only grant a warning', () => {
  renderGroup({
    ...SIGNED_IN,
    account: { ...ACCOUNT, guest: true, canWrite: false },
  });
  expect(screen.getByText('Guest')).toBeDefined();
  const warning = screen.getByText(LINEAR_READ_ONLY_GRANT);
  expect(warning.getAttribute('data-tone')).toBe('warning');
});

// The group re-renders from the account view the sign-out answers, as the
// hook writes it into the query cache.
function SignOutHarness({ revoked }: { revoked: boolean }) {
  const [view, setView] = useState<LinearAccountView>(SIGNED_IN);
  return (
    <LinearAccountGroup
      data={dataWith({
        linearAccount: view,
        ...handlers(),
        handleLinearSignOut: () => {
          setView(SIGNED_OUT);
          return Promise.resolve({ revoked });
        },
      })}
    />
  );
}

test('Sign out returns to the signed-out row', async () => {
  render(<SignOutHarness revoked />);
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  expect(
    await screen.findByRole('button', { name: 'Sign in with Linear' })
  ).toBeDefined();
  expect(screen.queryByText(LINEAR_NOT_REVOKED)).toBeNull();
});

test('a sign-out Linear could not confirm says how to end it there', async () => {
  render(<SignOutHarness revoked={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  expect(await screen.findByText(LINEAR_NOT_REVOKED)).toBeDefined();
});

test('Sign out names the workspace of the account it shows', async () => {
  const h = renderGroup(SIGNED_IN);
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  await waitFor(() =>
    expect(h.handleLinearSignOut).toHaveBeenCalledWith({ workspaceId: 'org-1' })
  );
});

test('signed in with the setup removed: still the account and its Sign out, with a warning', async () => {
  const h = renderGroup({
    ...SIGNED_IN,
    canSignIn: false,
    unavailable: 'not-configured',
    clientIdSource: null,
  });
  expect(
    screen.getByText('Signed in as Ada Lovelace (ada@example.com) in Acme')
  ).toBeDefined();
  const warning = screen.getByText(LINEAR_SIGN_IN_UNCONFIGURED);
  expect(warning.getAttribute('data-tone')).toBe('warning');
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  await waitFor(() =>
    expect(h.handleLinearSignOut).toHaveBeenCalledWith({ workspaceId: 'org-1' })
  );
});

const OTHER: NonNullable<LinearAccountView['account']> = {
  ...ACCOUNT,
  userId: 'u-ada-2',
  workspace: { id: 'org-2', name: 'Other Co', urlKey: 'other' },
};

test('sign-ins the project cannot place right now are listed, each with its own Sign out', async () => {
  const h = renderGroup({
    ...SIGNED_OUT,
    connection: null,
    stored: [ACCOUNT, OTHER],
  });
  expect(screen.getAllByText(LINEAR_STORED_SIGN_IN)).toHaveLength(2);
  expect(
    screen.getByText('Signed in as Ada Lovelace (ada@example.com) in Other Co')
  ).toBeDefined();
  const buttons = screen.getAllByRole('button', { name: 'Sign out' });
  expect(buttons).toHaveLength(2);
  const second = buttons[1];
  if (second === undefined) throw new Error('no second Sign out');
  fireEvent.click(second);
  await waitFor(() =>
    expect(h.handleLinearSignOut).toHaveBeenCalledWith({ workspaceId: 'org-2' })
  );
  // The way to sign in still follows.
  expect(
    screen.getByRole('button', { name: 'Sign in with Linear' })
  ).toBeDefined();
});

test('not connected, a stored sign-in still shows with its Sign out', () => {
  renderGroup({ ...unavailable('not-connected'), stored: [ACCOUNT] });
  expect(screen.getByText(LINEAR_STORED_SIGN_IN)).toBeDefined();
  expect(screen.getByRole('button', { name: 'Sign out' })).toBeDefined();
  expect(
    screen.getByText('Connect this project to Linear with an API key first.')
  ).toBeDefined();
});

test('a failed sign-out says why and keeps the account shown', async () => {
  renderGroup(SIGNED_IN, {
    handleLinearSignOut: mock(() =>
      Promise.reject(new Error('Linear could not be reached.'))
    ),
  });
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  const line = await screen.findByText('Linear could not be reached.');
  expect(line.getAttribute('data-tone')).toBe('danger');
  expect(screen.getByRole('button', { name: 'Sign out' })).toBeDefined();
});

// ---- problems ----------------------------------------------------------

const WRONG_WORKSPACE =
  'You signed in to Other Co, but this project syncs with Acme. Switch Linear to Acme in your browser, then sign in again.';

const PROBLEMS: {
  code: LinearSignInProblemCode;
  message: string;
  tone: string;
}[] = [
  {
    code: 'denied',
    message: 'Sign-in was cancelled in Linear. Nothing changed.',
    tone: 'warning',
  },
  {
    code: 'wrong-workspace',
    message: WRONG_WORKSPACE,
    tone: 'warning',
  },
  {
    code: 'expired',
    message: 'Sign-in timed out. Start again when you are ready.',
    tone: 'warning',
  },
  {
    code: 'ended',
    message:
      'Linear ended your sign-in. Sign in again; until then your changes go through the project connection.',
    tone: 'danger',
  },
  {
    code: 'failed',
    message:
      'Could not finish signing in: Linear could not be reached. Try again.',
    tone: 'danger',
  },
];

for (const { code, message, tone } of PROBLEMS) {
  test(`problem ${code}: shows the daemon's message in ${tone}, with Sign in again`, () => {
    renderGroup({ ...SIGNED_OUT, problem: { code, message } });
    const line = screen.getByText(message);
    expect(line.getAttribute('data-tone')).toBe(tone);
    expect(
      screen.getByRole('button', { name: 'Sign in with Linear' })
    ).toBeDefined();
    expect(
      screen.queryByRole('button', {
        name: 'Sign in with another workspace',
      }) !== null
    ).toBe(code === 'wrong-workspace');
  });
}

test('Sign in with another workspace asks Linear to show its workspace choice', async () => {
  const { replace } = stubTab();
  const h = renderGroup({
    ...SIGNED_OUT,
    problem: { code: 'wrong-workspace', message: WRONG_WORKSPACE },
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Sign in with another workspace' })
  );
  await waitFor(() => expect(replace).toHaveBeenCalledTimes(1));
  expect(h.handleLinearSignIn.mock.calls[0]?.[0]).toEqual({
    anotherWorkspace: true,
  });
});

test('a new attempt clears the row’s own last problem', async () => {
  stubTab();
  let fail = true;
  renderGroup(SIGNED_OUT, {
    handleLinearSignIn: mock(() =>
      fail
        ? Promise.reject(new Error('Linear could not be reached.'))
        : Promise.resolve({ authorizeUrl: AUTHORIZE_URL })
    ),
  });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in with Linear' }));
  await screen.findByText('Linear could not be reached.');
  fail = false;
  await act(async () => {
    fireEvent.click(
      screen.getByRole('button', { name: 'Sign in with Linear' })
    );
    await Promise.resolve();
  });
  await waitFor(() =>
    expect(screen.queryByText('Linear could not be reached.')).toBeNull()
  );
});

// ---- other viewers -----------------------------------------------------

test('a teammate reads why sign-in is not offered here, with no button and no identity', () => {
  renderGroup(unavailable('teammate'), {}, accessFor('decide', false));
  expect(screen.getByText(LINEAR_SIGN_IN_TEAMMATE)).toBeDefined();
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.queryByText(/Signed in as/)).toBeNull();
});

test('a window attached without the app token reads the attached explanation', () => {
  renderGroup(unavailable('attached'), {}, accessFor('request', true));
  expect(screen.getByText(ATTACHED_READ_ONLY)).toBeDefined();
  expect(screen.queryByRole('button')).toBeNull();
});

test('a project with no connection asks for one first', () => {
  renderGroup(unavailable('not-connected'));
  expect(
    screen.getByText('Connect this project to Linear with an API key first.')
  ).toBeDefined();
  expect(screen.queryByRole('button')).toBeNull();
});

test('while the view loads the group holds its place; an older daemon shows nothing', () => {
  const { unmount } = render(
    <LinearAccountGroup data={dataWith({ linearAccount: null })} />
  );
  expect(screen.getByText('Your Linear account')).toBeDefined();
  expect(screen.queryByRole('button')).toBeNull();
  unmount();
  render(
    <LinearAccountGroup
      data={dataWith({
        linearAccount: null,
        linearAccountError: new ApiError('not found', 404),
      })}
    />
  );
  expect(screen.queryByText('Your Linear account')).toBeNull();
});

// ---- inside the Linear page ---------------------------------------------

test('the Linear page shows the group under Connection, and names the connection’s user', () => {
  render(
    <LinearPanel
      data={dataWith({
        keySource: 'project',
        connected: true,
        linearAccount: SIGNED_OUT,
        ...handlers(),
      })}
    />
  );
  const headings = screen
    .getAllByRole('heading', { level: 2 })
    .map((h) => h.textContent);
  expect(headings.indexOf('Your Linear account')).toBe(
    headings.indexOf('Connection') + 1
  );
  expect(screen.getByText('Connected as Bot User')).toBeDefined();
});

test('the Linear page has no account group while the project is not connected', () => {
  render(
    <LinearPanel
      data={dataWith({ linearAccount: SIGNED_OUT, ...handlers() })}
    />
  );
  expect(screen.queryByText('Your Linear account')).toBeNull();
});

test('the Linear page keeps the group without a connection while a sign-in is stored', () => {
  render(
    <LinearPanel
      data={dataWith({
        linearAccount: { ...unavailable('not-connected'), stored: [ACCOUNT] },
        ...handlers(),
      })}
    />
  );
  expect(screen.getByText('Your Linear account')).toBeDefined();
  expect(screen.getByRole('button', { name: 'Sign out' })).toBeDefined();
});
