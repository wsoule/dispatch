import type { ApiClient, RunMeta } from '@dispatch/client';
import { router } from 'expo-router';
import { FlatList, Pressable, RefreshControl } from 'react-native';

import { useLive } from '../../src/live';
import { byRecency, isLive, stateText } from '../../src/runs';
import { ago, Body, Card, ConnectionNotice, Empty, Title } from '../../src/ui';

const load = async (client: ApiClient) =>
  (await client.fetchRuns()).slice().sort(byRecency).slice(0, 50);

function RunRow({ run }: { run: RunMeta }) {
  return (
    <Pressable
      onPress={() =>
        router.push({ pathname: '/run/[id]', params: { id: run.id } })
      }
    >
      <Card>
        <Title>{run.taskTitle}</Title>
        <Body muted={!isLive(run)} lines={2}>
          {stateText(run)}
        </Body>
        <Body muted>{ago(run.updatedAt)}</Body>
      </Card>
    </Pressable>
  );
}

export default function Runs() {
  const live = useLive(load, ['run.changed']);
  return (
    <FlatList
      data={live.data ?? []}
      keyExtractor={(r) => r.id}
      ListHeaderComponent={<ConnectionNotice />}
      renderItem={({ item }) => <RunRow run={item} />}
      ListEmptyComponent={
        live.data === undefined ? undefined : (
          <Empty>{live.error ?? 'No runs yet.'}</Empty>
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
