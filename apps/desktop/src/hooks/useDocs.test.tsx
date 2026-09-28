import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'bun:test';

import { applyDocsEvent, docsKey, refetchDocAfterSave } from './useDocs';

describe('applyDocsEvent', () => {
  it('invalidates every docs query on doc.changed and ignores other events', () => {
    const qc = new QueryClient();
    qc.setQueryData([...docsKey(7), 'list', {}], { docs: [], total: 0 });
    qc.setQueryData([...docsKey(7), 'doc', 'spec'], { text: 'x' });
    applyDocsEvent(qc, 7, { type: 'task.changed' });
    expect(
      qc.getQueryState([...docsKey(7), 'doc', 'spec'])?.isInvalidated
    ).toBe(false);
    applyDocsEvent(qc, 7, { type: 'doc.changed', scope: 'team', id: 'doc-1' });
    expect(
      qc.getQueryState([...docsKey(7), 'doc', 'spec'])?.isInvalidated
    ).toBe(true);
    expect(qc.getQueryState([...docsKey(7), 'list', {}])?.isInvalidated).toBe(
      true
    );
  });

  it('refetches after a daemon restart, which may have missed doc.changed', () => {
    const qc = new QueryClient();
    qc.setQueryData([...docsKey(7), 'doc', 'spec'], { text: 'x' });
    applyDocsEvent(qc, 7, { type: 'hello', version: '1' });
    expect(
      qc.getQueryState([...docsKey(7), 'doc', 'spec'])?.isInvalidated
    ).toBe(true);
  });
});

describe('refetchDocAfterSave', () => {
  it('drops a read that was in flight when the save landed', async () => {
    const qc = new QueryClient();
    const key = [...docsKey(7), 'doc', 'spec'];
    void qc
      .fetchQuery({ queryKey: key, queryFn: () => new Promise(() => {}) })
      .catch(() => {});
    expect(qc.getQueryState(key)?.fetchStatus).toBe('fetching');
    await refetchDocAfterSave(qc, 7, 'spec');
    expect(qc.getQueryState(key)?.fetchStatus).toBe('idle');
    expect(qc.getQueryState(key)?.isInvalidated).toBe(true);
  });

  it('leaves a settled read alone', async () => {
    const qc = new QueryClient();
    const key = [...docsKey(7), 'doc', 'spec'];
    qc.setQueryData(key, { text: 'x' });
    await refetchDocAfterSave(qc, 7, 'spec');
    expect(qc.getQueryState(key)?.isInvalidated).toBe(false);
  });
});
