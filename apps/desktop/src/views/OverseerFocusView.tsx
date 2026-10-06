import { X } from 'lucide-react';
import { useState } from 'react';

import { ConversationTimeline } from '../components/conversation/ConversationTimeline';
import { RoomHome } from '../components/conversation/Homes';
import { TaskPage } from '../components/tasks/page/TaskPage';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import type { TaskTab } from '../lib/appNav';
import type { RefAction } from '../lib/threadSources';
import type { OverseerFocus } from './TwoViewOverseer';
import { IconButton } from '@/ui/ai/icon-button';

/** A task in the middle; a message about it opens on its conversation. */
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
    <TaskPage
      layout="split"
      taskId={taskId}
      mode={mode}
      onModeChange={setMode}
      onClose={onClose}
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
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
            {name(address)}
          </span>
          <IconButton label="Close" onClick={onClose}>
            <X />
          </IconButton>
        </div>
      }
      emptyText="No messages yet."
    />
  );
}
