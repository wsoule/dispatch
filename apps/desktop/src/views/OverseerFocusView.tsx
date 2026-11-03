import { Button, Kbd, Tooltip } from '@dispatch/ui';
import { X } from 'lucide-react';
import { useState } from 'react';

import { ConversationTimeline } from '../components/conversation/ConversationTimeline';
import { RoomHome } from '../components/conversation/Homes';
import { TaskPageView } from '../components/tasks/page/TaskPageView';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import type { TaskTab } from '../lib/appNav';
import type { RefAction } from '../lib/threadSources';
import styles from './OverseerFocusView.module.css';
import type { OverseerFocus } from './OverseerView';

/**
 * A task in the middle: the same task page as Tasks (TaskPageView), embedded at heading
 * level 2 under the Overseer's own heading, with Close back to the talk and Expand out
 * to Tasks. TaskDetail's page layout stacks the property rail under the content while
 * the column is narrower than 760px, so the column needs no layout of its own. A message
 * about the task opens on its conversation.
 */
function FocusedTask({
  taskId,
  conversation,
  conversationCount,
  onClose,
  onExpand,
}: {
  taskId: string;
  conversation: boolean;
  conversationCount: number;
  onClose: () => void;
  onExpand: () => void;
}) {
  const [mode, setMode] = useState<TaskTab>(conversation ? 'thread' : 'auto');
  return (
    <TaskPageView
      embedded
      headingLevel={2}
      taskId={taskId}
      mode={mode}
      onModeChange={setMode}
      onBack={onClose}
      onExpand={onExpand}
      conversationCount={conversationCount}
    />
  );
}

/** What a side column opened, in the Overseer's middle in place of the talk. */
export function OverseerFocusView({
  focus,
  data,
  name,
  conversationCount,
  onOpenRef,
  onOpenInTasks,
  onClose,
}: {
  focus: OverseerFocus;
  data: DispatchProjectData;
  /** A display name for an address. */
  name: (address: string) => string;
  conversationCount: (taskId: string) => number;
  onOpenRef: (action: RefAction) => void;
  onOpenInTasks: (taskId: string) => void;
  onClose: () => void;
}) {
  if (focus.kind === 'task') {
    return (
      <FocusedTask
        key={focus.taskId}
        taskId={focus.taskId}
        conversation={focus.conversation === true}
        conversationCount={conversationCount(focus.taskId)}
        onClose={onClose}
        onExpand={() => onOpenInTasks(focus.taskId)}
      />
    );
  }
  const { address } = focus;
  if (address.startsWith('channel:')) {
    return (
      <RoomHome
        key={address}
        data={data}
        room={address.slice('channel:'.length)}
        onOpenRef={onOpenRef}
        onBack={onClose}
      />
    );
  }
  return (
    <ConversationTimeline
      key={address}
      data={data}
      query={{ with: address }}
      composerTo={address}
      composerLabel={name(address)}
      onOpenRef={onOpenRef}
      header={
        <div className={styles.header}>
          <span className={styles.name}>{name(address)}</span>
          <Tooltip
            side="bottom"
            content={
              <>
                Close · <Kbd>Esc</Kbd>
              </>
            }
          >
            <Button
              variant="quiet"
              size="sm"
              aria-label="Close"
              icon={<X size={14} strokeWidth={1.8} aria-hidden />}
              onClick={onClose}
            />
          </Tooltip>
        </div>
      }
      emptyText="No messages yet."
    />
  );
}
