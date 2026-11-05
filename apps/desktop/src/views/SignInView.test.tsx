import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, mock, test } from 'bun:test';

import { TeamLocalGate } from '../components/shell/TeamLocalGate';
import {
  clearTeamSession,
  isTeamLocalPage,
  readTeamSession,
  saveTeamSession,
} from '../lib/teamLocal';
import { checkTeamSession, SignInView, signInWithToken } from './SignInView';

function answering(status: number, body: object = {}): typeof fetch {
  return mock(() =>
    Promise.resolve(new Response(JSON.stringify(body), { status }))
  ) as unknown as typeof fetch;
}

const realFetch = globalThis.fetch;

/** Answers every fetch the page makes (SignInView and TeamLocalGate call the exported
 *  functions with their default, the global fetch) with one status and body. */
function stubFetch(status: number, body: object = {}): ReturnType<typeof mock> {
  const stub = mock(() =>
    Promise.resolve(new Response(JSON.stringify(body), { status }))
  );
  globalThis.fetch = stub as unknown as typeof fetch;
  return stub;
}

function tokenField(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>('Team token');
}

function signInButton(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>('button', {
    name: /Sign in|Checking/,
  });
}

afterEach(() => {
  delete (globalThis as { __DISPATCH_SHARED__?: unknown }).__DISPATCH_SHARED__;
  globalThis.fetch = realFetch;
  clearTeamSession();
});

describe('signInWithToken', () => {
  test('keeps who the daemon says the token is, and never the token', async () => {
    const session = await signInWithToken(
      'http://192.0.2.2:4771',
      'tok-1',
      answering(200, { handle: 'ada', ref: 'human:ada', tier: 'request' })
    );
    expect(session).toEqual({ handle: 'ada', tier: 'request' });
    expect(JSON.stringify(session)).not.toContain('tok-1');
  });

  test('posts the token to the session route, where the daemon sets the cookie', async () => {
    const fetchImpl = answering(200, { handle: 'ada', tier: 'decide' });
    await signInWithToken('http://192.0.2.2:4771', 'tok-2', fetchImpl);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof mock>).mock
      .calls[0] as [string, RequestInit];
    expect(url).toBe('http://192.0.2.2:4771/api/session');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ token: 'tok-2' });
  });

  test('a revoked or mistyped token fails with a sentence, not a status code', () => {
    expect(signInWithToken('http://x', 'nope', answering(401))).rejects.toThrow(
      'not recognised'
    );
  });

  test('an expired token says so, in the daemon’s own words', () => {
    expect(
      signInWithToken(
        'http://x',
        'old',
        answering(401, {
          code: 'auth_token_expired',
          error: 'this token for ada expired on 2026-01-01',
        })
      )
    ).rejects.toThrow('expired on 2026-01-01');
  });

  test('a daemon error says so', () => {
    expect(signInWithToken('http://x', 'tok', answering(503))).rejects.toThrow(
      '503'
    );
  });
});

describe('checkTeamSession', () => {
  test('asks whoami with no credential of its own — the cookie is the credential', async () => {
    const fetchImpl = answering(200, { handle: 'ada', tier: 'operator' });
    const session = await checkTeamSession('http://192.0.2.2:4771', fetchImpl);
    expect(session).toEqual({ handle: 'ada', tier: 'operator' });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof mock>).mock
      .calls[0] as [string, RequestInit | undefined];
    expect(url).toBe('http://192.0.2.2:4771/api/whoami');
    expect(init).toBeUndefined();
  });
});

describe('team session storage', () => {
  test('round-trips, and a malformed entry reads as signed out', () => {
    saveTeamSession({ handle: 'ada', tier: 'decide' });
    expect(readTeamSession()).toEqual({ handle: 'ada', tier: 'decide' });

    // The top rung reads back too, not just the two that existed first.
    saveTeamSession({ handle: 'linus', tier: 'operator' });
    expect(readTeamSession()?.tier).toBe('operator');

    window.localStorage.setItem(
      'dispatch:team-session',
      JSON.stringify({ handle: 'ada', tier: 'admin' })
    );
    expect(readTeamSession()).toBeNull();
  });

  test('never writes a token through, even if a caller carries one', () => {
    saveTeamSession({
      handle: 'ada',
      tier: 'request',
      token: 'secret',
    } as never);
    expect(window.localStorage.getItem('dispatch:team-session')).not.toContain(
      'secret'
    );
  });
});

describe('SignInView', () => {
  test('names the token field and keeps Sign in disabled until a token is typed', () => {
    render(<SignInView baseUrl="http://x" onSignedIn={() => {}} />);
    const field = tokenField();
    expect(field.type).toBe('password');
    expect(field.getAttribute('autocomplete')).toBe('off');
    expect(signInButton().disabled).toBe(true);

    fireEvent.change(field, { target: { value: '   ' } });
    expect(signInButton().disabled).toBe(true);

    fireEvent.change(field, { target: { value: 'tok-1' } });
    expect(signInButton().disabled).toBe(false);
  });

  test('a refused token shows the reason as an alert and keeps what was typed', async () => {
    const onSignedIn = mock(() => {});
    stubFetch(401);
    render(<SignInView baseUrl="http://x" onSignedIn={onSignedIn} />);
    fireEvent.change(tokenField(), { target: { value: 'nope' } });
    fireEvent.submit(tokenField().closest('form'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('not recognised');
    expect(tokenField().value).toBe('nope');
    expect(tokenField().getAttribute('aria-invalid')).toBe('true');
    expect(signInButton().textContent).toBe('Sign in');
    expect(onSignedIn).not.toHaveBeenCalled();
    expect(readTeamSession()).toBeNull();
  });

  test('an accepted token saves who it speaks for and signs in', async () => {
    const onSignedIn = mock(() => {});
    const fetchStub = stubFetch(200, { handle: 'ada', tier: 'decide' });
    render(<SignInView baseUrl="http://x" onSignedIn={onSignedIn} />);
    fireEvent.change(tokenField(), { target: { value: '  tok-3  ' } });
    // The button is the form's submit, so Enter in the field signs in as its click does.
    expect(signInButton().type).toBe('submit');
    fireEvent.click(signInButton());

    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    expect(onSignedIn).toHaveBeenCalledWith({ handle: 'ada', tier: 'decide' });
    expect(readTeamSession()).toEqual({ handle: 'ada', tier: 'decide' });
    const [url, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://x/api/session');
    // The typed token is trimmed before it is sent, and never stored.
    expect(JSON.parse(init.body as string)).toEqual({ token: 'tok-3' });
    expect(window.localStorage.getItem('dispatch:team-session')).not.toContain(
      'tok-3'
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('says Checking… on the busy button while the daemon answers', () => {
    globalThis.fetch = mock(
      () => new Promise<Response>(() => {})
    ) as unknown as typeof fetch;
    render(<SignInView baseUrl="http://x" onSignedIn={() => {}} />);
    fireEvent.change(tokenField(), { target: { value: 'tok-4' } });
    fireEvent.submit(tokenField().closest('form'));
    const button = signInButton();
    expect(button.textContent).toBe('Checking…');
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
  });

  test('shows why the last credential stopped working', () => {
    render(
      <SignInView
        baseUrl="http://x"
        notice="this token for ada expired on 2026-01-01"
        onSignedIn={() => {}}
      />
    );
    const notice = screen.getByText('this token for ada expired on 2026-01-01');
    expect(notice.closest('[data-tone="warning"]')).not.toBeNull();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Sign in to this project' })
    ).toBeTruthy();
    expect(screen.getByText('dispatch team invite').tagName).toBe('CODE');
  });
});

describe('TeamLocalGate', () => {
  test('is a no-op outside team-local mode', () => {
    expect(isTeamLocalPage()).toBe(false);
    render(
      <TeamLocalGate>
        <p>the app</p>
      </TeamLocalGate>
    );
    expect(screen.getByText('the app')).toBeTruthy();
  });

  test('on a team-local page with no credential, asks to sign in instead', () => {
    (globalThis as { __DISPATCH_SHARED__?: unknown }).__DISPATCH_SHARED__ = {
      root: '/repo',
      baseUrl: '',
    };
    expect(isTeamLocalPage()).toBe(true);
    render(
      <TeamLocalGate>
        <p>the app</p>
      </TeamLocalGate>
    );
    expect(screen.queryByText('the app')).toBeNull();
    expect(screen.getByText('Sign in to this project')).toBeTruthy();
    // The sign-in sits inside the gate frame: one main, under the Dispatch brand.
    const mains = screen.getAllByRole('main');
    expect(mains).toHaveLength(1);
    expect(mains[0].contains(tokenField())).toBe(true);
    expect(screen.getByRole('link', { name: 'Dispatch' })).toBeTruthy();
  });

  test('re-checks a stored session in the frame, and a refused one lands on sign-in with why', async () => {
    (globalThis as { __DISPATCH_SHARED__?: unknown }).__DISPATCH_SHARED__ = {
      root: '/repo',
      baseUrl: '',
    };
    saveTeamSession({ handle: 'ada', tier: 'decide' });
    stubFetch(401, {
      code: 'auth_token_expired',
      error: 'this token for ada expired on 2026-01-01',
    });
    render(
      <TeamLocalGate>
        <p>the app</p>
      </TeamLocalGate>
    );
    const checking = screen.getByRole('status', {
      name: 'Checking your session',
    });
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(screen.getByRole('main').contains(checking)).toBe(true);

    expect(
      await screen.findByText('this token for ada expired on 2026-01-01')
    ).toBeTruthy();
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(tokenField()).toBeTruthy();
    expect(screen.queryByText('the app')).toBeNull();
    expect(readTeamSession()).toBeNull();
  });

  test('a stored session the daemon still knows opens the app', async () => {
    (globalThis as { __DISPATCH_SHARED__?: unknown }).__DISPATCH_SHARED__ = {
      root: '/repo',
      baseUrl: '',
    };
    saveTeamSession({ handle: 'ada', tier: 'request' });
    stubFetch(200, { handle: 'ada', tier: 'decide' });
    render(
      <TeamLocalGate>
        <p>the app</p>
      </TeamLocalGate>
    );
    expect(await screen.findByText('the app')).toBeTruthy();
    expect(screen.queryByRole('main')).toBeNull();
    expect(readTeamSession()).toEqual({ handle: 'ada', tier: 'decide' });
  });
});
