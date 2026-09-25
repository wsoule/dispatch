import type { RunMeta, RunState } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import {
  assertCanDecide,
  ATTACHED_DAEMON_EXPLANATION,
  credentialTier,
  daemonBaseUrl,
  daemonRestartReadiness,
  decideAvailability,
  isInsufficientTier,
  isMissingOrInvalidToken,
  resolveDaemonAuth,
  RESTART_FOR_APPROVALS,
} from './daemonAuth';

function run(state: RunState): RunMeta {
  return { id: `r-${state}`, state } as RunMeta;
}

describe('resolveDaemonAuth', () => {
  test('a spawned daemon hands over the app token and decide tier', () => {
    expect(
      resolveDaemonAuth({ port: 45999, appToken: 'app', agentToken: 'agent' })
    ).toEqual({ token: 'app', canDecide: true });
  });

  test('an attached daemon falls back to the agent token without decide tier', () => {
    expect(
      resolveDaemonAuth({ port: 45999, appToken: null, agentToken: 'agent' })
    ).toEqual({ token: 'agent', canDecide: false });
  });

  test('a daemon predating token auth yields no credential at all', () => {
    expect(
      resolveDaemonAuth({ port: 45999, appToken: null, agentToken: null })
    ).toEqual({ token: undefined, canDecide: false });
  });

  test('an empty-string token is treated as absent, never sent', () => {
    expect(
      resolveDaemonAuth({ port: 45999, appToken: '', agentToken: '' })
    ).toEqual({ token: undefined, canDecide: false });
  });

  test('a team-local session presents no token — the cookie is sent by the browser', () => {
    const base = { port: 0, appToken: null, agentToken: null, baseUrl: '' };
    expect(
      resolveDaemonAuth({ ...base, session: { tier: 'request' } })
    ).toEqual({ token: undefined, canDecide: false });
    // Decide and operator both reach the Approve buttons.
    expect(resolveDaemonAuth({ ...base, session: { tier: 'decide' } })).toEqual(
      { token: undefined, canDecide: true }
    );
    expect(
      resolveDaemonAuth({ ...base, session: { tier: 'operator' } })
    ).toEqual({ token: undefined, canDecide: true });
  });

  test('no connection yet means no credential and no decide tier', () => {
    expect(resolveDaemonAuth(undefined)).toEqual({
      token: undefined,
      canDecide: false,
    });
  });
});

// The tier Settings assumes until /api/whoami answers, read off the credential.
describe('credentialTier', () => {
  const base = { port: 45999, appToken: null, agentToken: null };

  test('a teammate session says its own tier, whatever tokens are present', () => {
    expect(credentialTier({ ...base, session: { tier: 'request' } })).toBe(
      'request'
    );
    expect(credentialTier({ ...base, session: { tier: 'decide' } })).toBe(
      'decide'
    );
    // A session wins over an app token, which would otherwise mean operator.
    expect(
      credentialTier({
        ...base,
        appToken: 'app',
        session: { tier: 'decide' },
      })
    ).toBe('decide');
  });

  test('the app token is the owner, so operator', () => {
    expect(credentialTier({ ...base, appToken: 'app' })).toBe('operator');
    expect(
      credentialTier({ ...base, appToken: 'app', agentToken: 'agent' })
    ).toBe('operator');
  });

  test('only the on-disk agent token is request tier', () => {
    expect(credentialTier({ ...base, agentToken: 'agent' })).toBe('request');
    // An empty app token is no app token.
    expect(credentialTier({ ...base, appToken: '', agentToken: 'agent' })).toBe(
      'request'
    );
  });

  test('no credential at all is no tier', () => {
    expect(credentialTier(base)).toBeNull();
    expect(
      credentialTier({ ...base, appToken: '', agentToken: '' })
    ).toBeNull();
  });

  test('no connection yet is no tier', () => {
    expect(credentialTier(undefined)).toBeNull();
  });
});

describe('assertCanDecide', () => {
  test('passes through when the app token is held', () => {
    expect(() =>
      assertCanDecide({ token: 'app', canDecide: true })
    ).not.toThrow();
  });

  test('refuses locally rather than sending a request that can only 403', () => {
    expect(() => assertCanDecide({ token: 'agent', canDecide: false })).toThrow(
      ATTACHED_DAEMON_EXPLANATION
    );
  });

  test('refuses with no credential at all', () => {
    expect(() =>
      assertCanDecide({ token: undefined, canDecide: false })
    ).toThrow();
  });
});

describe('isInsufficientTier', () => {
  test('matches the daemon 403 by code', () => {
    expect(
      isInsufficientTier({ status: 403, code: 'auth_insufficient_tier' })
    ).toBe(true);
  });

  test('matches the code nested under a response body', () => {
    expect(
      isInsufficientTier({ body: { code: 'auth_insufficient_tier' } })
    ).toBe(true);
  });

  test('does not match the other auth codes or unrelated errors', () => {
    expect(isInsufficientTier({ code: 'auth_missing_token' })).toBe(false);
    expect(isInsufficientTier({ code: 'auth_invalid_token' })).toBe(false);
    expect(isInsufficientTier(new Error('cross-origin request rejected'))).toBe(
      false
    );
    expect(isInsufficientTier(null)).toBe(false);
    expect(isInsufficientTier('403')).toBe(false);
  });

  test('does not key on the message text, which is prose and drifts', () => {
    expect(
      isInsufficientTier(
        new Error('this route needs the daemon app token, which is never...')
      )
    ).toBe(false);
  });
});

describe('isMissingOrInvalidToken', () => {
  test('matches both credential-rejection codes and nothing else', () => {
    expect(isMissingOrInvalidToken({ code: 'auth_missing_token' })).toBe(true);
    expect(isMissingOrInvalidToken({ code: 'auth_invalid_token' })).toBe(true);
    expect(isMissingOrInvalidToken({ code: 'auth_insufficient_tier' })).toBe(
      false
    );
  });
});

describe('daemonRestartReadiness', () => {
  test('is safe when nothing is running', () => {
    expect(daemonRestartReadiness([])).toEqual({
      safe: true,
      blockedReason: null,
    });
    expect(
      daemonRestartReadiness([run('finished'), run('failed'), run('cancelled')])
    ).toEqual({ safe: true, blockedReason: null });
  });

  test('blocks while a run is in flight, since the daemon hosts it', () => {
    const readiness = daemonRestartReadiness([run('finished'), run('running')]);
    expect(readiness.safe).toBe(false);
    expect(readiness.blockedReason).toContain('1 run is still in flight');
  });

  test('counts every live run, and pluralizes', () => {
    const readiness = daemonRestartReadiness([
      run('running'),
      run('awaiting-approval'),
    ]);
    expect(readiness.safe).toBe(false);
    expect(readiness.blockedReason).toContain('2 runs are still in flight');
  });
});

describe('daemonBaseUrl', () => {
  test('uses the injected base URL when present', () => {
    expect(
      daemonBaseUrl({
        port: 1234,
        appToken: null,
        agentToken: null,
        baseUrl: 'https://demo.example/s/abc',
      })
    ).toBe('https://demo.example/s/abc');
  });

  test('falls back to loopback + port', () => {
    expect(
      daemonBaseUrl({ port: 1234, appToken: null, agentToken: null })
    ).toBe('http://127.0.0.1:1234');
  });

  test('empty string base does not win', () => {
    expect(
      daemonBaseUrl({ port: 9, appToken: null, agentToken: null, baseUrl: '' })
    ).toBe('http://127.0.0.1:9');
  });
});

describe('decideAvailability', () => {
  test('an app-token session enables the surface with no notice', () => {
    expect(
      decideAvailability({ token: 'app', canDecide: true }, [run('running')])
    ).toEqual({
      enabled: true,
      notice: null,
      explanation: null,
      restart: null,
    });
  });

  test('an attached session disables the surface and offers the restart', () => {
    const availability = decideAvailability(
      { token: 'agent', canDecide: false },
      []
    );
    expect(availability.enabled).toBe(false);
    expect(availability.notice).toBe(RESTART_FOR_APPROVALS);
    expect(availability.explanation).toBe(ATTACHED_DAEMON_EXPLANATION);
    expect(availability.restart).toEqual({ safe: true, blockedReason: null });
  });

  test('an attached session with live runs disables the restart too', () => {
    const availability = decideAvailability(
      { token: 'agent', canDecide: false },
      [run('running')]
    );
    expect(availability.enabled).toBe(false);
    expect(availability.restart?.safe).toBe(false);
  });
});
