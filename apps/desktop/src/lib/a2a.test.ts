import type {
  A2AListenerSettings,
  A2AListenerStatus,
  A2ATaskSummary,
  Message,
} from '@dispatch/client';
import { describe, expect, it } from 'bun:test';

import {
  a2aQueryKey,
  canDecline,
  cardSummary,
  formFromStatus,
  formToSettings,
  isA2AAddress,
  isFromA2AClient,
  listenerFieldOf,
  listenerStatusLine,
  openTasksByClient,
  originConflict,
  parseRecipients,
  peerAddresses,
  withHost,
} from './a2a';

const q = (over: Partial<Message> = {}): Message => ({
  id: 'm-1',
  thread: 'm-1',
  replyTo: null,
  from: 'agent:wyat/a2a.acme',
  to: ['human:wyat'],
  kind: 'question',
  body: 'Is /sessions final?',
  refs: [],
  urgent: false,
  blocking: true,
  wake: 'none',
  createdAt: '2026-09-25T00:00:00Z',
  ...over,
});

describe('A2A questions', () => {
  it('recognizes an A2A client sender', () => {
    expect(isFromA2AClient(q())).toBe(true);
    expect(isFromA2AClient(q({ from: 'agent:wyat/claude' }))).toBe(false);
    expect(isFromA2AClient(q({ from: 'agent:wyat/notes.a2a.x' }))).toBe(false);
  });
  it('offers Decline only to a deciding human, for a blocking plain question', () => {
    expect(canDecline(q(), true)).toBe(true);
    expect(canDecline(q(), false)).toBe(false);
    expect(canDecline(q({ blocking: false }), true)).toBe(false);
    expect(canDecline(q({ from: 'human:alice' }), true)).toBe(false);
    expect(canDecline(q({ kind: 'handoff' }), true)).toBe(false);
    expect(
      canDecline(
        q({
          data: {
            type: 'agent-registration',
            agent: 'agent:wyat/a2a.acme',
            client: 'a2a',
          },
        }),
        true
      )
    ).toBe(false);
  });
});

describe('the listener form', () => {
  const base = {
    enabled: true,
    host: '127.0.0.1' as const,
    port: '7450',
    publicUrl: '',
    certPath: '',
    keyPath: '',
    trustForwardedFor: false,
    standalone: false,
  };
  it('builds loopback settings with no public URL', () => {
    expect(formToSettings(base)).toEqual({
      ok: true,
      settings: {
        enabled: true,
        host: '127.0.0.1',
        port: 7450,
        publicUrl: null,
        tls: null,
        trustForwardedFor: false,
        standalone: false,
      },
    });
  });
  it('names the field a wildcard host is missing', () => {
    expect(formToSettings({ ...base, host: '0.0.0.0' })).toMatchObject({
      ok: false,
      field: 'certPath',
    });
    expect(
      formToSettings({
        ...base,
        host: '0.0.0.0',
        certPath: '/c',
        keyPath: '/k',
      })
    ).toMatchObject({ ok: false, field: 'publicUrl' });
    expect(formToSettings({ ...base, port: 'abc' })).toMatchObject({
      ok: false,
      field: 'port',
    });
  });
  it('takes a wildcard host with TLS and an https public URL', () => {
    expect(
      formToSettings({
        ...base,
        host: '0.0.0.0',
        certPath: ' /c ',
        keyPath: '/k',
        publicUrl: 'https://agent.example.com',
        trustForwardedFor: true,
      })
    ).toEqual({
      ok: true,
      settings: {
        enabled: true,
        host: '0.0.0.0',
        port: 7450,
        publicUrl: 'https://agent.example.com',
        tls: { certPath: '/c', keyPath: '/k' },
        trustForwardedFor: false,
        standalone: false,
      },
    });
  });
  it('refuses a plain-http public URL off loopback, a port out of range, and half a TLS pair', () => {
    expect(
      formToSettings({ ...base, publicUrl: 'http://agent.example.com' })
    ).toMatchObject({ ok: false, field: 'publicUrl' });
    expect(
      formToSettings({ ...base, publicUrl: 'http://localhost:7450' })
    ).toMatchObject({ ok: true });
    expect(formToSettings({ ...base, port: '70000' })).toMatchObject({
      ok: false,
      field: 'port',
    });
    expect(formToSettings({ ...base, certPath: '/c' })).toMatchObject({
      ok: false,
      field: 'keyPath',
    });
  });
});

describe('the form from the listener status', () => {
  const OFF: A2AListenerSettings = {
    enabled: false,
    host: '127.0.0.1',
    port: null,
    publicUrl: null,
    tls: null,
    trustForwardedFor: false,
    standalone: false,
  };
  const TEAM_TLS = { certPath: '/t/cert.pem', keyPath: '/t/key.pem' };
  const closed: A2AListenerStatus = {
    enabled: false,
    listening: false,
    url: null,
    error: null,
    warnings: [],
    legacyClients: [],
    settings: OFF,
    teamTls: null,
    suggestedPort: 51234,
  };
  const withSettings = (
    settings: A2AListenerSettings,
    over: Partial<A2AListenerStatus> = {}
  ): A2AListenerStatus => ({
    ...closed,
    enabled: settings.enabled,
    settings,
    ...over,
  });
  // What Save sends for a status shown and saved without an edit.
  const savedAsShown = (status: A2AListenerStatus) =>
    formToSettings({ ...formFromStatus(status), enabled: true });

  it('proposes loopback on the daemon’s free port, with no TLS even beside a team-local cert', () => {
    expect(formFromStatus({ ...closed, teamTls: TEAM_TLS })).toEqual({
      enabled: false,
      host: '127.0.0.1',
      port: '51234',
      publicUrl: '',
      certPath: '',
      keyPath: '',
      trustForwardedFor: false,
      standalone: false,
    });
  });
  it('shows a network listener with TLS as stored, and saves it back unchanged', () => {
    const wildcard: A2AListenerSettings = {
      enabled: true,
      host: '0.0.0.0',
      port: 8443,
      publicUrl: 'https://agent.example.com',
      tls: { certPath: '/c', keyPath: '/k' },
      trustForwardedFor: false,
      standalone: false,
    };
    const status = withSettings(wildcard, {
      listening: true,
      url: 'https://agent.example.com',
    });
    expect(formFromStatus(status)).toMatchObject({
      host: '0.0.0.0',
      port: '8443',
      certPath: '/c',
      keyPath: '/k',
      publicUrl: 'https://agent.example.com',
    });
    expect(savedAsShown(status)).toEqual({ ok: true, settings: wildcard });
  });
  it('keeps a disabled tunnel’s URL and X-Forwarded-For trust for when it comes back on', () => {
    const tunnel: A2AListenerSettings = {
      enabled: false,
      host: '127.0.0.1',
      port: 7450,
      publicUrl: 'https://agent.example.com',
      tls: null,
      trustForwardedFor: true,
      standalone: false,
    };
    expect(formFromStatus(withSettings(tunnel))).toMatchObject({
      enabled: false,
      trustForwardedFor: true,
    });
    expect(savedAsShown(withSettings(tunnel))).toEqual({
      ok: true,
      settings: { ...tunnel, enabled: true },
    });
  });
  it('shows a failing listener’s own settings, not the defaults', () => {
    const failing: A2AListenerSettings = {
      enabled: true,
      host: '0.0.0.0',
      port: 8443,
      publicUrl: 'https://agent.example.com',
      tls: { certPath: '/gone.pem', keyPath: '/k' },
      trustForwardedFor: false,
      standalone: false,
    };
    expect(
      formFromStatus(withSettings(failing, { error: 'cannot read /gone.pem' }))
    ).toMatchObject({ enabled: true, host: '0.0.0.0', certPath: '/gone.pem' });
  });
  it('keeps a host the picker does not list, and standalone, through a save', () => {
    const odd: A2AListenerSettings = {
      ...OFF,
      enabled: true,
      host: 'localhost',
      port: 7451,
      trustForwardedFor: true,
      standalone: true,
    };
    expect(savedAsShown(withSettings(odd))).toEqual({
      ok: true,
      settings: odd,
    });
  });
  it('offers the team-local cert to a network host that has no TLS files yet', () => {
    const noTls = withSettings(
      { ...OFF, host: '0.0.0.0', port: 8443 },
      { teamTls: TEAM_TLS }
    );
    expect(formFromStatus(noTls)).toMatchObject(TEAM_TLS);
    const loopback = formFromStatus({ ...closed, teamTls: TEAM_TLS });
    expect(withHost(loopback, '0.0.0.0', TEAM_TLS)).toMatchObject({
      host: '0.0.0.0',
      ...TEAM_TLS,
    });
    expect(withHost(loopback, '0.0.0.0', null)).toMatchObject({
      certPath: '',
      keyPath: '',
    });
    const typed = { ...loopback, certPath: '/mine.pem' };
    expect(withHost(typed, '0.0.0.0', TEAM_TLS)).toMatchObject({
      certPath: '/mine.pem',
      keyPath: '',
    });
    expect(withHost(loopback, '127.0.0.1', TEAM_TLS)).toMatchObject({
      certPath: '',
    });
  });
  it('says off, listening, or why it is closed', () => {
    expect(listenerStatusLine(closed)).toBe('Off');
    expect(
      listenerStatusLine({
        ...closed,
        enabled: true,
        listening: true,
        url: 'http://127.0.0.1:7450',
      })
    ).toBe('Listening at http://127.0.0.1:7450');
    expect(
      listenerStatusLine({
        ...closed,
        enabled: true,
        error: 'port is required',
      })
    ).toBe('Closed: port is required');
  });
  it("maps the daemon's settings keys onto the form's fields", () => {
    expect(listenerFieldOf('tls.certPath')).toBe('certPath');
    expect(listenerFieldOf('tls')).toBe('certPath');
    expect(listenerFieldOf('tls.keyPath')).toBe('keyPath');
    expect(listenerFieldOf('publicUrl')).toBe('publicUrl');
    expect(listenerFieldOf('standalone')).toBeNull();
  });
});

describe('clients, tasks and the card', () => {
  it('keys every A2A query under one prefix', () => {
    expect(a2aQueryKey('http://127.0.0.1:1', 'clients')).toEqual([
      'dispatch-a2a',
      'http://127.0.0.1:1',
      'clients',
    ]);
  });
  it('reads recipients as human addresses', () => {
    expect(parseRecipients(' alice, human:bob  carol ')).toEqual([
      'human:alice',
      'human:bob',
      'human:carol',
    ]);
    expect(parseRecipients('  ')).toEqual([]);
  });
  it('groups the unfinished tasks by client, newest first as listed', () => {
    const task = (over: Partial<A2ATaskSummary>): A2ATaskSummary => ({
      id: 'm-1',
      client: 'agent:wyat/a2a.acme',
      contextId: 'm-1',
      skill: 'ask',
      dispatchTask: null,
      gate: null,
      state: 'WORKING',
      statusAt: '2026-09-25T00:00:00Z',
      canceledAt: null,
      declinedAt: null,
      createdAt: '2026-09-25T00:00:00Z',
      ...over,
    });
    const grouped = openTasksByClient([
      task({ id: 'm-3' }),
      task({ id: 'm-2', state: 'COMPLETED' }),
      task({ id: 'm-1', client: 'agent:wyat/a2a.beta' }),
      task({ id: 'm-0' }),
    ]);
    expect(
      [...grouped].map(([client, tasks]) => [client, tasks.map((t) => t.id)])
    ).toEqual([
      ['agent:wyat/a2a.acme', ['m-3', 'm-0']],
      ['agent:wyat/a2a.beta', ['m-1']],
    ]);
  });
  it("reads a card's name, description, skills and URL, whatever else it holds", () => {
    expect(
      cardSummary({
        name: 'Acme API',
        description: 'A Dispatch project.',
        supportedInterfaces: [{ url: 'http://127.0.0.1:7450/a2a/v1' }],
        skills: [{ id: 'ask', name: 'Ask' }, { id: 'status' }, 'junk'],
      })
    ).toEqual({
      name: 'Acme API',
      description: 'A Dispatch project.',
      url: 'http://127.0.0.1:7450/a2a/v1',
      skills: ['Ask', 'status'],
    });
    expect(cardSummary({})).toEqual({
      name: '',
      description: '',
      url: null,
      skills: [],
    });
  });
});

describe('peers', () => {
  it('recognizes peers and clients as A2A, and nothing else', () => {
    expect(isA2AAddress('a2a:acme')).toBe(true);
    expect(isA2AAddress('agent:wyat/a2a.acme')).toBe(true);
    expect(isA2AAddress('agent:wyat/claude')).toBe(false);
    expect(isA2AAddress('human:alice')).toBe(false);
  });

  it('offers only active peers for completion', () => {
    expect(
      peerAddresses([
        { alias: 'acme', status: 'active' },
        { alias: 'dead', status: 'auth-failed' },
      ])
    ).toEqual(['a2a:acme']);
  });

  it('reads both origins out of an allowOrigin refusal', () => {
    expect(
      originConflict({
        field: 'allowOrigin',
        message:
          'allowOrigin: the card at https://a.example.com points at https://b.example.com; confirm with --allow-origin',
      })
    ).toEqual({
      cardOrigin: 'https://a.example.com',
      interfaceOrigin: 'https://b.example.com',
    });
    expect(originConflict({ field: 'cardUrl', message: 'x' })).toBeNull();
  });
});
