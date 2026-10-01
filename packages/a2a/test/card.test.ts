import { AgentCard, verifyAgentCardSignature } from '@a2a-js/sdk';
import { describe, expect, it } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';

import {
  buildCard,
  buildCardJson,
  BUILT_SKILLS,
  cardEtag,
  cardJson,
  offeredSkills,
  signCard,
  unsignedCardEtag,
  unsignedCardJson,
} from '../src/card.js';
import type { CardInputs } from '../src/port.js';
import { handoffStatuses, namedStatusVocabulary } from '../src/statuses.js';
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

const named = (names: string[]) =>
  handoffStatuses(namedStatusVocabulary(names));

describe('offeredSkills', () => {
  it('builds ask, handoff and status', () => {
    expect(BUILT_SKILLS).toEqual(['ask', 'handoff', 'status']);
  });
  const all = ['ask', 'handoff', 'status'] as const;
  it('omits handoff when the project lacks draft, ready, dropped or landed', () => {
    expect(offeredSkills(null, named(['todo', 'doing', 'done']), all)).toEqual([
      'ask',
      'status',
    ]);
    expect(
      offeredSkills(null, named(['backlog', 'ready', 'landed', 'dropped']), all)
    ).toEqual(['ask', 'handoff', 'status']);
  });
  it('offers only what is both configured and built', () => {
    expect(
      offeredSkills(
        ['ask', 'handoff'],
        named(['draft', 'ready', 'landed', 'dropped']),
        ['ask']
      )
    ).toEqual(['ask']);
  });
});

const SIGNED: CardInputs = {
  name: 'Acme API',
  description: null,
  publicUrl: 'https://acme-agent.example.com',
  version: '1.0.0',
  skills: ['ask'],
  blockingWaitSec: 60,
  pushNotifications: true,
};

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  });
  return {
    privateJwk: privateKey.export({ format: 'jwk' }) as Record<string, string>,
    publicJwk: publicKey.export({ format: 'jwk' }) as Record<string, string>,
  };
}

describe('signed cards', () => {
  it('signs the canonical card so the SDK verifies it, and a changed card fails', async () => {
    const { privateJwk, publicJwk } = keyPair();
    const jku = 'https://acme-agent.example.com/.well-known/jwks.json';
    const signatures = await signCard(unsignedCardJson(SIGNED), {
      privateJwk,
      kid: 'k1',
      jku,
    });
    expect(signatures).toHaveLength(1);
    const header = JSON.parse(
      Buffer.from(signatures[0].protected, 'base64url').toString('utf8')
    ) as Record<string, string>;
    expect(header).toMatchObject({ alg: 'ES256', kid: 'k1', jku });
    expect(JSON.stringify(signatures)).not.toContain(String(privateJwk.d));
    const verify = verifyAgentCardSignature((kid) => {
      expect(kid).toBe('k1');
      return Promise.resolve(publicJwk);
    });
    await expect(
      verify(AgentCard.fromJSON(buildCardJson({ ...SIGNED, signatures })))
    ).resolves.toBeUndefined();
    await expect(
      verify(
        AgentCard.fromJSON({
          ...buildCardJson({ ...SIGNED, signatures }),
          name: 'Evil API',
        })
      )
    ).rejects.toThrow();
  });

  it('keeps one ETag with and without signatures, and never puts the JWKS in the card', () => {
    const signed = {
      ...SIGNED,
      signatures: [{ protected: 'p', signature: 's' }],
    };
    expect(cardEtag(buildCard(signed))).toBe(cardEtag(buildCard(SIGNED)));
    expect(unsignedCardEtag(signed)).toBe(cardEtag(buildCard(SIGNED)));
    expect(
      JSON.stringify(
        buildCardJson({ ...SIGNED, jwks: { keys: [{ kty: 'EC' }] } })
      )
    ).not.toContain('"keys"');
    expect(unsignedCardJson(signed)).not.toHaveProperty('signatures');
  });
});
