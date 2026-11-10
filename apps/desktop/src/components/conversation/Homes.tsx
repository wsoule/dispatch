import { isContainerKind } from '@dispatch-foo/core/browser';
import { Button, Chip, InitialsAvatar, SectionHeader } from '@dispatch/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { useTaskComments } from '../../hooks/useTaskComments';
import { threadsPrefix, useChannels } from '../../hooks/useThreads';
import type { RefAction } from '../../lib/threadSources';
import { TasksPageHeader } from '../tasks/TasksPageHeader';
import { ConversationTimeline } from './ConversationTimeline';
import styles from './Homes.module.css';

// Follow or leave a room; humans are never implicit members.
function FollowButton({
  data,
  room,
}: {
  data: DispatchProjectData;
  /** A bare room name: `release`, `milestone/t-1`. */
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
      size="sm"
      variant={following ? 'quiet' : 'secondary'}
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

/** A task's conversation; a milestone's is its room, `channel:milestone/<id>`. */
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
    const room = `milestone/${taskId}`;
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
          <div className={styles.roomHead}>
            <div className={styles.follow}>
              <FollowButton data={data} room={room} />
            </div>
            <p className={styles.reach}>
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
        <span className={styles.note}>
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
    <div data-testid="room-page" className={styles.room}>
      <TasksPageHeader
        onBack={onBack}
        crumb={[`# ${room}`]}
        actions={<FollowButton data={data} room={room} />}
      />
      <div className={styles.members}>
        <SectionHeader
          as="h2"
          name="Members"
          count={members.length}
          className={styles.membersHead}
        />
        <ul aria-label="Members" className={styles.memberList}>
          {members.slice(0, 8).map((member) => {
            const name = memberLabel(member, data.people);
            return (
              <li key={member}>
                <Chip>
                  <span className={styles.member}>
                    <InitialsAvatar name={name} />
                    {name}
                  </span>
                </Chip>
              </li>
            );
          })}
          {members.length > 8 && (
            <li className={styles.more}>+{members.length - 8}</li>
          )}
        </ul>
      </div>
      <div className={styles.timeline}>
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
