import { afterEach, describe, expect, it, jest, spyOn } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DaemonDocsHost } from '../../src/docs/host.js';
import { openDocs } from '../../src/docs/open.js';
import type { RunMeta } from '../../src/orchestrator/types.js';
import { OWNER, RUN } from './fakeHost.js';

let root = '';
afterEach(() => {
  jest.useRealTimers();
  if (root !== '') rmSync(root, { recursive: true, force: true });
  root = '';
});

describe('openDocs', () => {
  it('wires live notices into the daemon: changes, the sweep, run ends and stop', () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'docs-open-')));
    mkdirSync(join(root, '.dispatch'));
    writeFileSync(
      join(root, '.dispatch', 'config.yml'),
      'docs:\n  coalesceMinutes: 0\n  noticeMinutes: 5\n'
    );
    const dbDir = join(root, 'runs', 'project');
    mkdirSync(dbDir, { recursive: true });
    jest.useFakeTimers();
    const errors = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const lines: string[] = [];
      const terminal: ((meta: RunMeta) => void)[] = [];
      const host = new DaemonDocsHost({
        store: { get: () => null } as never,
        events: { broadcast: () => undefined },
      });
      host.bindRuns({
        list: () =>
          [
            { id: 'r-1', kind: 'execute', taskId: 't-1', state: 'running' },
          ] as never,
        taskIdOfRun: (id) => (id === 'r-1' ? 't-1' : null),
        notifyRun: (_runId, line) => {
          lines.push(line);
        },
        onRunTerminal: (callback) => {
          terminal.push(callback);
          return () => undefined;
        },
      });
      const docs = openDocs({
        rootDir: root,
        host,
        ownerRef: 'human:wyat',
        dbPath: join(dbDir, 'docs.db'),
      });
      const owner = docs.service.actorFor(OWNER);
      const append = (text: string) => ({
        ops: [{ op: 'append' as const, text }],
      });
      const created = docs.service.create(owner, {
        title: 'Spec',
        body: 'v1\n',
      });
      docs.service.read(docs.service.actorFor(RUN), 'spec');
      docs.service.edit(owner, 'spec', append('v2'));
      const v3 = docs.service.edit(owner, 'spec', append('v3'));
      const told = (n: number) =>
        `📄 doc · spec rev ${n} by human:wyat: appended (doc_read to see)`;
      expect(lines).toEqual([told(2)]);
      // The sweep sends the trailing notice once docs.noticeMinutes pass.
      jest.advanceTimersByTime(4 * 60_000);
      expect(lines).toEqual([told(2)]);
      jest.advanceTimersByTime(60_000);
      expect(lines).toEqual([told(2), told(3)]);
      // An ended run's reads are forgotten, so it hears of no later change.
      for (const callback of terminal) callback({ id: 'r-1' } as RunMeta);
      jest.advanceTimersByTime(6 * 60_000);
      docs.service.edit(owner, 'spec', append('v4'));
      expect(lines).toEqual([told(2), told(3)]);
      docs.stop();
      host.changed({
        doc: created.doc.id,
        scope: 'team',
        kind: 'sealed',
        author: 'human:wyat',
        rev: v3.rev.id,
        summary: 'appended',
      });
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});
