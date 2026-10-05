import type { DocLink } from '@dispatch/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, mock, test } from 'bun:test';

import type { RefAction } from '../../lib/threadSources';
import { docLinkAction, DocLinksRail } from './DocLinksRail';

const link = (type: DocLink['target']['type'], id: string): DocLink => ({
  doc: 'doc-1',
  target: { type, id },
  rel: 'spec',
  source: 'manual',
  createdBy: 'human:wyat',
  createdAt: '2026-10-05T10:00:00.000Z',
});

const taskIdOfRun = (runId: string) => (runId === 'r-1' ? 't-1' : null);

test('a doc link leads where a ref chip to the same target would', () => {
  expect(docLinkAction(link('task', 't-9').target, taskIdOfRun)).toEqual({
    kind: 'task',
    taskId: 't-9',
  });
  expect(docLinkAction(link('run', 'r-1').target, taskIdOfRun)).toEqual({
    kind: 'run',
    taskId: 't-1',
    runId: 'r-1',
  });
  expect(docLinkAction(link('thread', 'm-1').target, taskIdOfRun)).toEqual({
    kind: 'message',
    messageId: 'm-1',
  });
  expect(docLinkAction(link('doc', 'doc-2').target, taskIdOfRun)).toEqual({
    kind: 'doc',
    docId: 'doc-2',
    anchor: null,
  });
  expect(docLinkAction(link('memory', 'mem-1').target, taskIdOfRun)).toBeNull();
  expect(docLinkAction(link('run', 'r-gone').target, taskIdOfRun)).toBeNull();
});

test('the rail opens a linked target and leaves one with no page as text', () => {
  const onOpen = mock((_a: RefAction) => {});
  render(
    <DocLinksRail
      links={[link('task', 't-9'), link('memory', 'mem-1')]}
      onOpen={onOpen}
      taskIdOfRun={taskIdOfRun}
    />
  );
  const buttons = screen.getAllByTestId('doc-link');
  expect(buttons.map((b) => b.textContent)).toEqual(['task:t-9']);
  fireEvent.click(buttons[0]);
  expect(onOpen).toHaveBeenCalledWith({ kind: 'task', taskId: 't-9' });
  expect(screen.getByText('memory:mem-1').tagName).toBe('SPAN');
});
