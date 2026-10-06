import { useQuery } from '@tanstack/react-query';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { threadListsKey } from '../../hooks/useThreads';
import { subjectOf } from '../../lib/conversationScope';
import type { RefAction } from '../../lib/threadSources';
import { ConversationTimeline } from '../conversation/ConversationTimeline';
import { PeekDrawer } from './PeekDrawer';

function clock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
      });
}

/** A person: who they are, whether they are here, and everything between the two of you. */
export function PersonPeek({
  data,
  address,
  onOpenRef,
  onClose,
}: {
  data: DispatchProjectData;
  address: string;
  onOpenRef: (action: RefAction) => void;
  onClose: () => void;
}) {
  const { client, port, me, messageAccess } = data;
  const person = data.people.find((p) => p.ref === address);
  const name = person?.name ?? address.replace(/^human:/, '');
  const here = data.presence.find((p) => p.ref === address);
  // Same key as the timeline below, so this reads its cache.
  const query = { with: address };
  const conversation = useQuery({
    queryKey: [...threadListsKey(port), 'conversation', query],
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.getConversation({ ...query, limit: 200 });
    },
    enabled: client !== null && messageAccess.canMessage,
    retry: false,
  });
  // At most six work subjects, never rooms.
  const elsewhere = [
    ...new Set(
      (conversation.data?.messages ?? [])
        .map((m) => (me === null ? '' : subjectOf(m, me)))
        .filter((s) => s.startsWith('task:'))
    ),
  ].slice(0, 6);

  return (
    <PeekDrawer
      label={`Conversation with ${name}`}
      testId="person-peek"
      title={name}
      onClose={onClose}
    >
      <div className="border-border flex flex-col gap-1.5 border-b-[0.5px] px-3 py-2 text-[12px]">
        <span className="text-muted-foreground">
          {here === undefined
            ? 'Not on this daemon right now'
            : [
                `here since ${clock(here.since)}`,
                `${here.runs.length} ${here.runs.length === 1 ? 'agent' : 'agents'} running`,
                ...(here.viewing === null ? [] : [`viewing ${here.viewing}`]),
              ].join(' · ')}
        </span>
        {elsewhere.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-muted-foreground">
              Elsewhere with {name}:
            </span>
            {elsewhere.map((subject) => {
              const taskId = subject.slice('task:'.length);
              return (
                <button
                  key={subject}
                  type="button"
                  onClick={() => onOpenRef({ kind: 'task', taskId })}
                  className="rounded-pill border-border-chip border-[0.5px] px-2 hover:underline"
                >
                  {taskId}
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1">
        <ConversationTimeline
          data={data}
          query={query}
          composerTo={address}
          composerLabel={name}
          onOpenRef={onOpenRef}
          emptyText={`Nothing between you and ${name} yet.`}
        />
      </div>
    </PeekDrawer>
  );
}
