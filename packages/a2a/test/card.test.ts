import { AgentCard } from '@a2a-js/sdk';
import { describe, expect, it } from 'bun:test';

import {
  buildCard,
  buildCardJson,
  cardEtag,
  cardJson,
  offeredSkills,
} from '../src/card.js';
import { ENVELOPE_URI, GATE_URI, WORK_URI } from '../src/uris.js';

const inputs = {
  name: 'Acme API',
  description: null,
  publicUrl: 'https://acme-agent.example.com',
  version: '0.33.0',
  skills: ['ask', 'handoff', 'status'] as const,
  blockingWaitSec: 60,
  pushNotifications: false,
};

describe('buildCardJson', () => {
  it('matches the spec card (spec:708-776)', () => {
    const card = buildCardJson({ ...inputs, skills: [...inputs.skills] });
    expect(card).toMatchObject({
      name: 'Acme API',
      supportedInterfaces: [
        {
          url: 'https://acme-agent.example.com/a2a/v1',
          protocolBinding: 'HTTP+JSON',
          protocolVersion: '1.0',
        },
      ],
      version: '0.33.0',
      capabilities: {
        streaming: true,
        pushNotifications: false,
        extendedAgentCard: false,
        extensions: [
          { uri: ENVELOPE_URI, required: false },
          { uri: GATE_URI, required: false },
          { uri: WORK_URI, required: false },
        ],
      },
      securitySchemes: {
        bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } },
      },
      securityRequirements: [{ schemes: { bearer: { list: [] } } }],
      defaultInputModes: ['text/plain', 'text/markdown', 'application/json'],
      defaultOutputModes: ['text/markdown', 'text/plain', 'application/json'],
    });
    expect((card.skills as { id: string }[]).map((s) => s.id)).toEqual([
      'ask',
      'handoff',
      'status',
    ]);
  });

  it('states the configured blocking wait in the ask skill', () => {
    const card = buildCardJson({
      ...inputs,
      skills: ['ask'],
      blockingWaitSec: 120,
    });
    expect(JSON.stringify(card)).toContain('at most 120 s');
  });

  it('names no owner handle or teammate', () => {
    expect(
      JSON.stringify(buildCardJson({ ...inputs, skills: ['ask'] }))
    ).not.toMatch(/human:|agent:/);
  });

  it('parses as an SDK AgentCard', () => {
    expect(
      AgentCard.toJSON(buildCard({ ...inputs, skills: ['ask'] }))
    ).toMatchObject({
      name: 'Acme API',
      securityRequirements: [{ schemes: { bearer: {} } }],
    });
  });
});

describe('cardJson', () => {
  it('is the card exactly as the listener serves it', () => {
    const served = { ...inputs, skills: ['ask' as const] };
    expect(cardJson(served)).toEqual(AgentCard.toJSON(buildCard(served)));
  });
});

describe('cardEtag', () => {
  it('is stable for the same card and changes with its content', () => {
    const a = cardEtag(buildCard({ ...inputs, skills: ['ask'] }));
    expect(cardEtag(buildCard({ ...inputs, skills: ['ask'] }))).toBe(a);
    expect(a).toMatch(/^"[0-9a-f]{16}"$/);
    expect(
      cardEtag(buildCard({ ...inputs, skills: ['ask'], description: 'Other' }))
    ).not.toBe(a);
  });
});

describe('offeredSkills', () => {
  const all = ['ask', 'handoff', 'status'] as const;
  it('omits handoff when the project lacks draft, ready, dropped or landed', () => {
    expect(offeredSkills(null, ['todo', 'doing', 'done'], all)).toEqual([
      'ask',
      'status',
    ]);
    expect(
      offeredSkills(null, ['backlog', 'ready', 'landed', 'dropped'], all)
    ).toEqual(['ask', 'handoff', 'status']);
  });
  it('offers only what is both configured and built', () => {
    expect(
      offeredSkills(
        ['ask', 'handoff'],
        ['draft', 'ready', 'landed', 'dropped'],
        ['ask']
      )
    ).toEqual(['ask']);
  });
});
