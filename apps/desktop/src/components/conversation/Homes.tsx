import { isContainerKind } from '@dispatch-foo/core/browser';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { useTaskComments } from '../../hooks/useTaskComments';
import { threadsPrefix, useChannels } from '../../hooks/useThreads';
import type { RefAction } from '../../lib/threadSources';
import { TasksPageHeader } from '../tasks/TasksPageHeader';
import { ConversationTimeline } from './ConversationTimeline';
import { InitialsAvatar } from '@/ui/ai/initials-avatar';
import { Button } from '@/ui/button';
import { SectionLabel } from '@/ui/chrome/SectionLabel';

// Follow or leave a room; humans are never implicit members.
function FollowButton({
  data,
  room,
}: {
  data: DispatchProjectData;
  /** A bare room name: `release`, `epic/t-1`. */
  room: string;
}) {
  const { client, port, me, messageAccess } = data;
  const queryClient = useQueryClient();
  const channels = useChannels(client, port, messageAccess.canMessage);
  const [busy, setBusy] = useState(false);
  const following =
    me !== null &&
    (channels.find((c) => c.name === room)?.members.includes(me) ?? false);
  if (client === null || me === null) return null;
  return (
    <Button
      size="xs"
      variant={following ? 'ghost' : 'outline'}
      disabled={busy}
      data-testid="follow-room"
      onClick={() => {
        setBusy(true);
        const change = following
          ? client.leaveChannel(room, me)
          : client.joinChannel(room, me);
        void change
          .then(() =>
            queryClient.invalidateQueries({ queryKey: threadsPrefix(port) })
          )
          .finally(() => setBusy(false));
      }}
    >
      {following ? 'Following · Leave' : 'Follow'}
    </Button>
  );
}

/** A task's conversation; a milestone's is its room, `channel:epic/<id>`. */
export function TaskConversationHome({
  data,
  taskId,
  onOpenRef,
}: {
  data: DispatchProjectData;
  taskId: string;
  onOpenRef: (action: RefAction) => void;
}) {
  const doc = data.tasksIncludingArchived.find((t) => t.meta.id === taskId);
  const container = doc !== undefined && isContainerKind(doc.meta.kind);
  const comments = useTaskComments(
    data.client,
    data.port,
    container ? null : taskId,
    data.me
  );
  if (container) {
    const room = `epic/${taskId}`;
    const children = data.tasks.filter((t) => t.meta.parent === taskId).length;
    return (
      <ConversationTimeline
        data={data}
        query={{ about: `channel:${room}` }}
        composerTo={`channel:${room}`}
        composerLabel={doc.meta.title}
        onOpenRef={onOpenRef}
        emptyText="Nothing said about this milestone yet."
        header={
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2">
              <FollowButton data={data} room={room} />
            </div>
            <p className="text-muted-foreground text-[11px]">
              Reaches {children} direct child{' '}
              {children === 1 ? 'task’s' : 'tasks’'} agents at their next turn ·
              sub-issues not included · wake off
            </p>
          </div>
        }
      />
    );
  }
  return (
    <ConversationTimeline
      data={data}
      query={{ about: `task:${taskId}` }}
      comments={comments}
      composerTo={`task:${taskId}`}
      composerLabel={taskId}
      onOpenRef={onOpenRef}
      emptyText="No conversation on this task yet."
      header={
        <span className="text-muted-foreground text-[12px]">
          Comments sync with the team · messages stay on this daemon
        </span>
      }
    />
  );
}

// A member's chip label: a person's name, or the address with what kind of member it is.
function memberLabel(
  member: string,
  people: DispatchProjectData['people']
): string {
  if (member.startsWith('a2a:')) return `${member.slice(4)} · A2A`;
  if (member.startsWith('run:') || member.startsWith('agent:')) {
    return `${member.replace(/^(run|agent):/, '')} · agent`;
  }
  return (
    people.find((p) => p.ref === member)?.name ?? member.replace(/^human:/, '')
  );
}

/** A named room (#release): members, Follow, a flat timeline. Never listed; reached by name. */
export function RoomHome({
  data,
  room,
  onOpenRef,
  onBack,
}: {
  data: DispatchProjectData;
  room: string;
  onOpenRef: (action: RefAction) => void;
  /** Back to the Tasks list. */
  onBack: () => void;
}) {
  const channels = useChannels(
    data.client,
    data.port,
    data.messageAccess.canMessage
  );
  const members = channels.find((c) => c.name === room)?.members ?? [];
  return (
    <div data-testid="room-page" className="flex h-full min-h-0 flex-col">
      <TasksPageHeader
        onBack={onBack}
        crumb={[`# ${room}`]}
        actions={<FollowButton data={data} room={room} />}
      />
      <div className="shadow-hairline-bottom flex flex-wrap items-center gap-1.5 px-4 py-2">
        <SectionLabel count={members.length}>Members</SectionLabel>
        {members.slice(0, 8).map((member) => (
          <span
            key={member}
            className="rounded-control border-border-chip flex h-[22px] items-center gap-1.5 border-[0.5px] px-2 text-[11.5px] text-(--text-secondary)"
          >
            <InitialsAvatar
              name={memberLabel(member, data.people)}
              className="size-3.5 text-[7px]"
            />
            {memberLabel(member, data.people)}
          </span>
        ))}
        {members.length > 8 && (
          <span className="text-muted-foreground text-[11.5px]">
            +{members.length - 8}
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1">
        <ConversationTimeline
          data={data}
          query={{ about: `channel:${room}` }}
          composerTo={`channel:${room}`}
          composerLabel={`# ${room}`}
          onOpenRef={onOpenRef}
          emptyText={`Nothing said in # ${room} yet.`}
        />
      </div>
    </div>
  );
}
