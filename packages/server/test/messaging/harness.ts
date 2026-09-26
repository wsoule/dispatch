import type { TaskStorePort } from '@dispatch/core';
import { TaskStore } from '@dispatch/core';
import type { Sender } from '@dispatch/protocol';
import { afterEach, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../../src/cache.js';
import { EventBus } from '../../src/events.js';
import { LedgerStore } from '../../src/ledger.js';
import type { Messaging } from '../../src/messaging/service.js';
import { openMessaging } from '../../src/messaging/service.js';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import type {
  ApprovalDecision,
  Executor,
  ExecutorEvents,
  ExecutorRun,
  ExecutorStartOptions,
} from '../../src/orchestrator/types.js';
import { initGitRepo } from '../orchestrator/helpers.js';

export const HUMAN: Sender = { address: 'human:wyat', canDecide: true };

// Every policy Activity line openRecovered's messaging appended in this test.
export const activity: { taskId: string; text: string }[] = [];

// Waits for `check` to become true, polling rather than sleeping a fixed
// amount — the delivery/run-start flows here settle asynchronously.
export async function waitFor(
  check: () => boolean,
  timeoutMs = 3000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timed out');
}

// A fresh git repo and DISPATCH_HOME per test, removed afterwards; call once
// at the top of a test file and read root() inside each test.
export function useTempProject(): { root(): string } {
  let root: string | undefined;
  let fakeHome: string | undefined;
  const originalDispatchHome = process.env.DISPATCH_HOME;

  beforeEach(() => {
    activity.length = 0;
    fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
    process.env.DISPATCH_HOME = fakeHome;
    root = initGitRepo('dispatch-messaging-');
  });

  afterEach(() => {
    if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
    else process.env.DISPATCH_HOME = originalDispatchHome;
    if (fakeHome !== undefined)
      rmSync(fakeHome, { recursive: true, force: true });
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
    fakeHome = undefined;
    root = undefined;
  });

  return {
    root() {
      if (root === undefined) throw new Error('no temp project outside a test');
      return root;
    },
  };
}

// A bare orchestrator over `root`'s task store, with no executors registered.
export function makeOrchestrator(root: string): {
  orchestrator: Orchestrator;
  store: TaskStore;
  events: EventBus;
} {
  const store = TaskStore.init(root);
  const cache = new TaskCache();
  cache.rebuild(store);
  const events = new EventBus();
  const orchestrator = new Orchestrator({
    rootDir: root,
    store,
    cache,
    events,
  });
  return { orchestrator, store, events };
}

// openMessaging over `root` with messages.db at its top level, recovered and
// ready to send. Policy Activity lines land in `activity`.
export async function openRecovered(
  root: string,
  orchestrator: Orchestrator,
  store: TaskStorePort,
  events: EventBus = new EventBus(),
  extra: Pick<Parameters<typeof openMessaging>[0], 'scopeExpiry'> = {}
): Promise<Messaging> {
  const messaging = openMessaging({
    rootDir: root,
    orchestrator,
    store,
    events,
    ownerRef: 'human:wyat',
    dbPath: join(root, 'messages.db'),
    ledgerStore: new LedgerStore(root),
    appendPolicyActivity: (taskId, text) => activity.push({ taskId, text }),
    ...extra,
  });
  await messaging.recover();
  return messaging;
}

// An executor whose run parks on a tool call when the test says so, and
// records every decision the orchestrator hands back.
export class ParkingExecutor implements Executor {
  readonly decisions: { requestId: string; decision: ApprovalDecision }[] = [];
  private events: ExecutorEvents | null = null;

  start(_opts: ExecutorStartOptions, events: ExecutorEvents): ExecutorRun {
    this.events = events;
    events.onSession?.('session-parking');
    return {
      interrupt: () => Promise.resolve(),
      requestStop: () => {},
      send: () => {},
      notify: () => {},
      approve: (requestId, decision) => {
        this.decisions.push({ requestId, decision });
      },
    };
  }

  park(requestId: string, toolName: string, input: unknown): void {
    if (this.events === null) throw new Error('ParkingExecutor never started');
    this.events.onApprovalRequest({ requestId, toolName, input });
  }

  // Reports the session's result, as the Claude executor does right before it
  // refuses every call still parked.
  windDown(): void {
    if (this.events === null) throw new Error('ParkingExecutor never started');
    this.events.onEnding?.();
  }
}
