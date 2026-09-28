import { AgentCard, canonicalizeAgentCard } from '@a2a-js/sdk';
import { canonicalStatus } from '@dispatch/core';
import type { A2ASkill } from '@dispatch/core';
import type { JsonValue } from '@dispatch/protocol';
import { createHash } from 'node:crypto';

import type { CardInputs } from './port.js';
import { ENVELOPE_URI, GATE_URI, WORK_URI } from './uris.js';

export const BUILT_SKILLS: readonly A2ASkill[] = ['ask', 'handoff', 'status'];
export const DEFAULT_CARD_DESCRIPTION =
  'A Dispatch project. Ask its owner a question, hand off a piece of software work (the owner approves it before anything runs), or check the status of your handoffs.';
const HANDOFF_STATUSES = ['draft', 'ready', 'dropped', 'landed'];

// A handoff needs the statuses its draft moves through; legacy names count.
export function handoffSupported(statuses: readonly string[]): boolean {
  const have = new Set(statuses.map(canonicalStatus));
  return HANDOFF_STATUSES.every((s) => have.has(s));
}

// The skills the card lists: configured (or every built one) and built, with
// handoff only when the project's statuses support it.
export function offeredSkills(
  configured: readonly A2ASkill[] | null,
  statuses: readonly string[],
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

// The project's agent card as ProtoJSON: one HTTP+JSON interface, bearer auth,
// the three optional extensions, and no owner or teammate names.
export function buildCardJson(inputs: CardInputs): Record<string, JsonValue> {
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

export function buildCard(inputs: CardInputs): AgentCard {
  return AgentCard.fromJSON(buildCardJson(inputs));
}

// The card exactly as the listener serves it, for GET /api/a2a/card.
export function cardJson(inputs: CardInputs): unknown {
  return AgentCard.toJSON(buildCard(inputs));
}

// A strong ETag over the canonical card, so a changed card busts caches.
export function cardEtag(card: AgentCard): string {
  const digest = createHash('sha256')
    .update(canonicalizeAgentCard(card))
    .digest('hex');
  return `"${digest.slice(0, 16)}"`;
}
