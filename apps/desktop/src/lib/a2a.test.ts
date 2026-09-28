import type {
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
  isFromA2AClient,
  listenerFieldOf,
  listenerStatusLine,
  openTasksByClient,
  parseRecipients,
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
  const closed: A2AListenerStatus = {
    enabled: false,
    listening: false,
    url: null,
    error: null,
    warnings: [],
    legacyClients: [],
  };
  it('proposes loopback on the default port, with the team-local cert', () => {
    expect(
      formFromStatus(closed, { certPath: '/t/cert.pem', keyPath: '/t/key.pem' })
    ).toEqual({
      enabled: false,
      host: '127.0.0.1',
      port: '7450',
      publicUrl: '',
      certPath: '/t/cert.pem',
      keyPath: '/t/key.pem',
      trustForwardedFor: false,
    });
  });
  it('reads the port of a loopback listener from its URL', () => {
    expect(
      formFromStatus(
        {
          ...closed,
          enabled: true,
          listening: true,
          url: 'http://127.0.0.1:8123',
        },
        null
      )
    ).toMatchObject({ enabled: true, port: '8123', publicUrl: '' });
  });
  it('keeps a public URL and leaves the port for the owner to confirm', () => {
    expect(
      formFromStatus(
        {
          ...closed,
          enabled: true,
          listening: true,
          url: 'https://agent.example.com',
        },
        null
      )
    ).toMatchObject({ publicUrl: 'https://agent.example.com', port: '' });
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
