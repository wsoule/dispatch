import type { ApiClient, RunMeta } from '@dispatch/client';
import * as Haptics from 'expo-haptics';
import { router, useNavigation } from 'expo-router';
import { useLayoutEffect, useState } from 'react';
import {
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  Text,
  View,
} from 'react-native';

import { useLive } from '../../src/live';
import { useRemote } from '../../src/remote';
import { byRecency, isLive, runStatus, stateText } from '../../src/runs';
import { font, useColours } from '../../src/theme';
import {
  ago,
  Body,
  Button,
  Card,
  Chip,
  ConnectionNotice,
  Empty,
  Meta,
  SectionLabel,
  TitleRow,
} from '../../src/ui';

// Starting and watching work. The tasks ready to start come first, each with
// Start; then live runs, then the newest. New opens a task typed here.

/** Ready tasks shown before "more on your Mac"; the phone starts the next
 *  few, the board is where the queue gets sorted. */
const READY_SHOWN = 5;

type ReadyTask = Awaited<ReturnType<ApiClient['fetchReadyTaskList']>>[number];

const loadRuns = async (client: ApiClient) =>
  (await client.fetchRuns()).slice().sort(byRecency).slice(0, 50);

const loadReady = (client: ApiClient) => client.fetchReadyTaskList();

function RunRow({ run }: { run: RunMeta }) {
  return (
    <Pressable
      onPress={() =>
        router.push({ pathname: '/run/[id]', params: { id: run.id } })
      }
    >
      <Card>
        <TitleRow title={run.taskTitle} right={<Chip {...runStatus(run)} />} />
        <Body muted={!isLive(run)} lines={2}>
          {stateText(run)}
        </Body>
        <Meta>{ago(run.updatedAt)}</Meta>
      </Card>
    </Pressable>
  );
}

function ReadyRow({
  task,
  starting,
  onStart,
}: {
  task: ReadyTask;
  starting: boolean;
  onStart: () => void;
}) {
  return (
    <Card>
      <TitleRow
        title={task.meta.title}
        right={
          <Button
            label={starting ? 'Starting…' : 'Start'}
            tone="primary"
            disabled={starting}
            onPress={onStart}
          />
        }
      />
      <Meta>
        {task.readiness === undefined
          ? task.meta.id
          : `${task.meta.id} · ${task.readiness.label}`}
      </Meta>
    </Card>
  );
}

export default function Runs() {
  const c = useColours();
  const navigation = useNavigation();
  const { client } = useRemote();
  const live = useLive(loadRuns, ['run.changed']);
  const ready = useLive(loadReady, ['task.changed', 'run.changed']);
  const [starting, setStarting] = useState<string | null>(null);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New task"
          onPress={() => router.push('/task/new')}
          style={{ paddingHorizontal: 16 }}
        >
          <Text style={{ color: c.accentInk, fontFamily: font.medium }}>
            New
          </Text>
        </Pressable>
      ),
    });
  }, [navigation, c.accentInk]);

  // One tap starts an agent on the Mac, so the button is the only target:
  // a row tap while scrolling must not.
  const start = async (task: ReadyTask) => {
    if (client === null || starting !== null) return;
    setStarting(task.meta.id);
    try {
      const run = await client.createRun(task.meta.id);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.push({ pathname: '/run/[id]', params: { id: run.id } });
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      Alert.alert(
        'Could not start it',
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      setStarting(null);
      void ready.refresh();
    }
  };

  const queue = ready.data ?? [];
  const more = queue.length - READY_SHOWN;
  const runs = live.data ?? [];

  return (
    <FlatList
      data={runs}
      keyExtractor={(r) => r.id}
      ListHeaderComponent={
        <View>
          <ConnectionNotice />
          {queue.length === 0 ? null : (
            <>
              <SectionLabel>Ready to start</SectionLabel>
              {queue.slice(0, READY_SHOWN).map((task) => (
                <ReadyRow
                  key={task.meta.id}
                  task={task}
                  starting={starting === task.meta.id}
                  onStart={() => void start(task)}
                />
              ))}
              {more > 0 ? (
                <View style={{ marginHorizontal: 18, marginTop: 10 }}>
                  <Meta>{`${more} more ready on your Mac`}</Meta>
                </View>
              ) : null}
              {runs.length === 0 ? null : <SectionLabel>Runs</SectionLabel>}
            </>
          )}
        </View>
      }
      renderItem={({ item }) => <RunRow run={item} />}
      ListEmptyComponent={
        live.data === undefined || queue.length > 0 ? undefined : (
          <Empty>
            {live.error ?? 'No runs yet. Tap New to write a task and start it.'}
          </Empty>
        )
      }
      refreshControl={
        <RefreshControl
          refreshing={live.loading}
          onRefresh={() => {
            void live.refresh();
            void ready.refresh();
          }}
        />
      }
      contentContainerStyle={{ paddingBottom: 24 }}
    />
  );
}
