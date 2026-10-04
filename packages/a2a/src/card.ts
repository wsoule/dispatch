import { AgentCard, generateAgentCardSignature } from '@a2a-js/sdk';
import type { A2ASkill } from '@dispatch/core';
import type { JsonValue } from '@dispatch/protocol';
import { FlattenedSign, flattenedVerify, importJWK } from 'jose';
import type { JWK } from 'jose';
import { createHash } from 'node:crypto';

import type { CardInputs, CardSignatureJson } from './port.js';
import { handoffSupported } from './statuses.js';
import type { HandoffStatuses } from './statuses.js';
import { ENVELOPE_URI, GATE_URI, WORK_URI } from './uris.js';

export const BUILT_SKILLS: readonly A2ASkill[] = ['ask', 'handoff', 'status'];
export const DEFAULT_CARD_DESCRIPTION =
  'A Dispatch project. Ask its owner a question, hand off a piece of software work (the owner approves it before anything runs), or check the status of your handoffs.';
// The skills the card lists: configured (or every built one) and built, with
// handoff only when the project's statuses support it.
export function offeredSkills(
  configured: readonly A2ASkill[] | null,
  statuses: HandoffStatuses,
  built: readonly A2ASkill[] = BUILT_SKILLS
): A2ASkill[] {
  const wanted = configured ?? built;
  return built.filter(
    (s) => wanted.includes(s) && (s !== 'handoff' || handoffSupported(statuses))
  );
}

function skillJson(skill: A2ASkill, waitSec: number): JsonValue {
  switch (skill) {
    case 'ask':
      return {
        id: 'ask',
        name: 'Ask',
        description: `Ask the project owner a question (or, with the envelope extension, a task you handed off). Answers can take hours: send with returnImmediately and subscribe or poll. A blocking send returns after at most ${waitSec} s even without an answer, a documented deviation from A2A §3.2.2. The answer is the \`answer\` artifact.`,
        tags: ['question', 'dispatch'],
        examples: ['Is the /sessions response shape final?'],
      };
    case 'handoff':
      return {
        id: 'handoff',
        name: 'Hand off work',
        description:
          'Propose a piece of software work with the work extension (skill: handoff, title required). It becomes a draft task the owner approves before anything runs. Results: pr, diffstat and evidence artifacts.',
        tags: ['handoff', 'code', 'dispatch'],
        examples: ['Add rate limiting to the public upload endpoint'],
      };
    case 'status':
      return {
        id: 'status',
        name: 'Status',
        description:
          'Report the Dispatch status (draft through landed) of your handoffs. GetTask and ListTasks give the same information.',
        tags: ['status', 'dispatch'],
      };
  }
}

/** Where a signed card's JWKS is served, relative to its public URL. */
export const JWKS_PATH = '/.well-known/jwks.json';

// The project's agent card as ProtoJSON: one HTTP+JSON interface, bearer auth,
// the three optional extensions, and no owner or teammate names. Unsigned.
export function unsignedCardJson(
  inputs: CardInputs
): Record<string, JsonValue> {
  return {
    name: inputs.name,
    description: inputs.description ?? DEFAULT_CARD_DESCRIPTION,
    supportedInterfaces: [
      {
        url: `${inputs.publicUrl.replace(/\/$/, '')}/a2a/v1`,
        protocolBinding: 'HTTP+JSON',
        protocolVersion: '1.0',
      },
    ],
    version: inputs.version,
    capabilities: {
      streaming: true,
      pushNotifications: inputs.pushNotifications,
      extendedAgentCard: false,
      extensions: [
        {
          uri: ENVELOPE_URI,
          description:
            'Dispatch addressing: recipients, kinds, replies, choices, refs.',
          required: false,
        },
        {
          uri: GATE_URI,
          description:
            'Why a task is AUTH_REQUIRED. Read-only: only the owner answers gates.',
          required: false,
        },
        {
          uri: WORK_URI,
          description:
            'Handoff fields, task status and work artifacts (PR, diffstat, evidence).',
          required: false,
        },
      ],
    },
    securitySchemes: {
      bearer: {
        httpAuthSecurityScheme: {
          scheme: 'Bearer',
          description:
            'A per-client token from the project owner (`dispatch a2a clients add`).',
        },
      },
    },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    defaultInputModes: ['text/plain', 'text/markdown', 'application/json'],
    defaultOutputModes: ['text/markdown', 'text/plain', 'application/json'],
    skills: inputs.skills.map((s) => skillJson(s, inputs.blockingWaitSec)),
  };
}

// The served card: the unsigned card plus any signatures the port supplied.
// The JWKS is never part of it.
export function buildCardJson(inputs: CardInputs): Record<string, JsonValue> {
  const card = unsignedCardJson(inputs);
  return inputs.signatures === undefined || inputs.signatures.length === 0
    ? card
    : {
        ...card,
        signatures: inputs.signatures.map((sig) => ({
          ...sig,
        })) as unknown as JsonValue,
      };
}

export function buildCard(inputs: CardInputs): AgentCard {
  return AgentCard.fromJSON(buildCardJson(inputs));
}

// The card exactly as the listener serves it, for GET /api/a2a/card.
export function cardJson(inputs: CardInputs): unknown {
  return AgentCard.toJSON(buildCard(inputs));
}

// RFC 8785 (JCS): object keys sorted by UTF-16 code unit, strings and numbers
// in their ECMAScript JSON forms, no whitespace.
function jcs(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jcs).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${jcs(record[k])}`)
    .join(',')}}`;
}

// The served card's JSON, as AgentCard.toJSON writes it.
function servedForm(card: Record<string, unknown>): Record<string, unknown> {
  return AgentCard.toJSON(AgentCard.fromJSON(card)) as Record<string, unknown>;
}

// JCS of a card's JSON exactly as given, minus `signatures`: what Dispatch's
// own signature covers, every field included.
function canonicalCard(json: Record<string, unknown>): string {
  const { signatures: _signatures, ...rest } = json;
  return jcs(rest);
}

// The protected-header `typ` that marks Dispatch's own card signature.
const DISPATCH_CARD_TYP = 'dispatch-card+jws';

// A strong ETag over the canonical card without its signatures, so a changed
// card busts caches while a re-signed one (ES256 is randomized) does not.
export function cardEtag(card: AgentCard): string {
  const digest = createHash('sha256')
    .update(canonicalCard(AgentCard.toJSON(card) as Record<string, unknown>))
    .digest('hex');
  return `"${digest.slice(0, 16)}"`;
}

export function unsignedCardEtag(inputs: CardInputs): string {
  return cardEtag(AgentCard.fromJSON(unsignedCardJson(inputs)));
}

// Two JWS (spec:791-794, A2A §8.4), ES256 with the key's kid and jku. The
// first covers the full card's JCS form, auth fields included; the second
// covers the SDK 1.2.0 canonical form, so SDK verifiers accept the card.
export async function signCard(
  unsigned: Record<string, JsonValue>,
  key: { privateJwk: Record<string, JsonValue>; kid: string; jku: string }
): Promise<CardSignatureJson[]> {
  const header = { alg: 'ES256', kid: key.kid, jku: key.jku, typ: 'JOSE' };
  // Signed as served, so the bytes a client fetches are the bytes covered.
  const jws = await new FlattenedSign(
    new TextEncoder().encode(canonicalCard(servedForm(unsigned)))
  )
    .setProtectedHeader({ ...header, typ: DISPATCH_CARD_TYP })
    .sign(await importJWK(key.privateJwk as JWK, 'ES256'));
  const sdkSign = generateAgentCardSignature(
    key.privateJwk as unknown as Parameters<
      typeof generateAgentCardSignature
    >[0],
    header
  );
  const sdkSigned = AgentCard.toJSON(
    await sdkSign(AgentCard.fromJSON(unsigned))
  ) as { signatures?: CardSignatureJson[] };
  // A protected header is always set above, so jose always returns one.
  return [
    { protected: jws.protected ?? '', signature: jws.signature },
    ...(sdkSigned.signatures ?? []),
  ];
}

// Whether Dispatch's own signature (typ DISPATCH_CARD_TYP; never the
// SDK-form one, which leaves the auth fields out) verifies over the card's
// JSON as received, under the key `keyFor` returns for its kid.
export async function verifyCardSignature(
  served: Record<string, unknown>,
  keyFor: (kid: string, jku: string | undefined) => Promise<JWK>
): Promise<boolean> {
  const signatures = Array.isArray(served.signatures)
    ? (served.signatures as CardSignatureJson[])
    : [];
  const payload = Buffer.from(canonicalCard(served)).toString('base64url');
  for (const sig of signatures) {
    try {
      const header = JSON.parse(
        Buffer.from(sig.protected, 'base64url').toString('utf8')
      ) as { kid?: string; jku?: string; typ?: string };
      if (header.kid === undefined || header.typ !== DISPATCH_CARD_TYP)
        continue;
      const key = await importJWK(
        await keyFor(header.kid, header.jku),
        'ES256'
      );
      await flattenedVerify(
        { payload, protected: sig.protected, signature: sig.signature },
        key
      );
      return true;
    } catch {
      // Try the next signature.
    }
  }
  return false;
}
