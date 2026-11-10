import type { ApiClient, MergeQueueEntry, RunMeta } from '@dispatch/client';
import { router } from 'expo-router';
import { FlatList, Pressable, RefreshControl } from 'react-native';

import { useLive } from '../../src/live';
import { awaitsReview } from '../../src/runs';
import { ago, Body, Card, ConnectionNotice, Empty, Title } from '../../src/ui';

// The finished runs waiting on a review, and what the merge queue is doing.
// Opening one shows its diff with Merge and Discard.

interface ReviewData {
  waiting: RunMeta[];
  queue: MergeQueueEntry[];
}

const load = async (client: ApiClient): Promise<ReviewData> => {
  const [runs, queue] = await Promise.all([
    client.fetchRuns(),
    client.fetchMergeQueue(),
  ]);
  const queued = new Set(queue.entries.map((e) => e.runId));
  return {
    waiting: runs
      .filter((r) => awaitsReview(r) && !queued.has(r.id))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    queue: queue.entries,
  };
};

type Item =
  | { kind: 'run'; run: RunMeta }
  | { kind: 'queued'; entry: MergeQueueEntry };

const QUEUE_TEXT: Record<MergeQueueEntry['state'], string> = {
  queued: 'Queued to merge',
  'waiting-blockers': 'Waiting for the work it builds on',
  'blocked-environment': 'Held: your checkout cannot take a merge right now',
  'waiting-github': 'Waiting on GitHub',
  rebasing: 'Rebasing',
  verifying: 'Running checks',
  merging: 'Merging',
  merged: 'Merged',
  failed: 'Merge failed',
};

export default function Review() {
  const live = useLive(load, ['run.changed', 'merge-queue.changed']);
  const items: Item[] = [
    ...(live.data?.queue ?? []).map((entry) => ({
      kind: 'queued' as const,
      entry,
    })),
    ...(live.data?.waiting ?? []).map((run) => ({ kind: 'run' as const, run })),
  ];
  return (
    <FlatList
      data={items}
      keyExtractor={(item) =>
        item.kind === 'run' ? item.run.id : `q-${item.entry.runId}`
      }
      ListHeaderComponent={<ConnectionNotice />}
      renderItem={({ item }) => {
        const id = item.kind === 'run' ? item.run.id : item.entry.runId;
        return (
          <Pressable
            onPress={() =>
              router.push({ pathname: '/run/[id]', params: { id } })
            }
          >
            <Card>
              <Title>
                {item.kind === 'run'
                  ? item.run.taskTitle
                  : item.entry.taskTitle}
              </Title>
              {item.kind === 'run' ? (
                <Body muted>Finished {ago(item.run.updatedAt)}</Body>
              ) : (
                <Body muted lines={3}>
                  {item.entry.reason === undefined
                    ? QUEUE_TEXT[item.entry.state]
                    : `${QUEUE_TEXT[item.entry.state]}: ${item.entry.reason}`}
                </Body>
              )}
            </Card>
          </Pressable>
        );
      }}
      ListEmptyComponent={
        live.data === undefined ? undefined : (
          <Empty>{live.error ?? 'Nothing to review.'}</Empty>
        )
      }
      refreshControl={
        <RefreshControl
          refreshing={live.loading}
          onRefresh={() => void live.refresh()}
        />
      }
      contentContainerStyle={{ paddingBottom: 24 }}
    />
  );
}
