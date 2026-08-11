import { BRANCH_FIXES } from '@dispatch/demo/repo';
import type {
  FakeExecutorScript,
  PlanProposal,
} from '@dispatch/server/testing';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The storefront demo's one scripted run reuses the real cart fix content
// from BRANCH_FIXES, so the run's diff is a genuine storefront change rather
// than throwaway marker text (mirrors bin.ts's buildDefaultFakeScript, which
// does the same with its own FAKE_OUTPUT.txt fixture). Resolved eagerly into
// an IIFE (rather than a bare `const` + guard) so TypeScript keeps the
// non-undefined narrowing across the closures below — a plain top-level guard
// doesn't survive being read from a function declared later in the module.
const CART_FIX: (typeof BRANCH_FIXES)[number] = (() => {
  const fix = BRANCH_FIXES.find((f) => f.task === 't-2e91aa');
  if (fix === undefined) {
    throw new Error('demo cart fix missing from BRANCH_FIXES');
  }
  return fix;
})();

// Builds one NormalizedEntry the FakeExecutor plays back verbatim through
// onEntry. Tool entries default to `status: 'running'`, matching every real
// executor's tool-call entries before they resolve.
function entry(kind: 'assistant' | 'tool', text: string, toolName?: string) {
  return {
    ts: new Date().toISOString(),
    kind,
    text,
    ...(toolName === undefined ? {} : { toolName, status: 'running' as const }),
  };
}

/**
 * A fresh ~15s scripted storefront run: read the broken provider, propose a
 * plan, make a real edit + commit, pause for one approval, then finish.
 * Called once per daemon start (not module-level) so each run gets its own
 * timestamps.
 */
export function buildStorefrontRunScript(): FakeExecutorScript {
  return {
    session: 'demo-session',
    steps: [
      {
        entry: entry(
          'assistant',
          'Reading the cart provider and the failing session test…'
        ),
        delayMs: 2500,
      },
      { entry: entry('tool', `Read ${CART_FIX.file}`, 'Read'), delayMs: 2000 },
      {
        entry: entry(
          'assistant',
          [
            '## Plan',
            '',
            '1. Move cart state into the session store',
            '2. Drop the module-level singleton',
            '3. Re-run the cart tests',
          ].join('\n')
        ),
        delayMs: 3000,
      },
      {
        entry: entry('tool', `Edit ${CART_FIX.file}`, 'Edit'),
        write: (cwd) =>
          writeFileSync(join(cwd, CART_FIX.file), CART_FIX.contents),
        commitMessage: 'fix: move cart state to the session',
        delayMs: 2500,
      },
      {
        entry: entry('tool', 'Bash bun test test/cart.test.ts', 'Bash'),
        approval: {
          requestId: 'demo-approval-1',
          toolName: 'Bash',
          input: { command: 'bun test test/cart.test.ts' },
        },
      },
      {
        entry: entry(
          'assistant',
          'Cart tests pass. The provider now scopes state per session.'
        ),
        delayMs: 2000,
      },
    ],
    finish: {
      state: 'finished',
      costUsd: 0.38,
      turns: 9,
      sessionId: 'demo-session',
    },
  };
}

// The one plan proposal the storefront demo's fake planner returns — a small,
// plausible feature (gift cards) with a real dependency arrow between tasks,
// mirroring bin.ts's DEFAULT_FAKE_PROPOSAL shape field-for-field.
export const STOREFRONT_PLAN_PROPOSAL: PlanProposal = {
  epic: {
    title: 'Gift cards at checkout',
    description:
      'Sell and redeem gift cards: purchase flow, balance check, redemption at checkout.',
  },
  tasks: [
    {
      title: 'Add gift card SKU and purchase endpoint',
      description:
        'New product type plus a POST /gift-cards route issuing a code.',
      acceptanceCriteria: ['Purchasing returns a redeemable code'],
      blockedByIndices: [],
      priority: 'high',
    },
    {
      title: 'Balance lookup endpoint',
      description: 'GET /gift-cards/:code returns remaining balance.',
      acceptanceCriteria: ['Unknown codes 404'],
      blockedByIndices: [0],
      priority: 'medium',
    },
    {
      title: 'Redeem at checkout',
      description:
        'Apply a gift card code as tender during checkout, partial redemption allowed.',
      acceptanceCriteria: ['Total reflects redemption', 'Balance decremented'],
      blockedByIndices: [1],
      priority: 'medium',
    },
  ],
};
