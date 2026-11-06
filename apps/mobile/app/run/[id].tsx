import type {
  ApiClient,
  DiffResult,
  NormalizedEntry,
  RunDetailView,
} from '@dispatch/client';
import * as Haptics from 'expo-haptics';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, RefreshControl, ScrollView } from 'react-native';

import { useLive } from '../../src/live';
import { useRemote } from '../../src/remote';
import { awaitsReview, isLive, stateText } from '../../src/runs';
import { Body, Button, Card, ConnectionNotice, Row, Title } from '../../src/ui';

// One run: where it stands, its log as it happens, and the actions a phone
// can take on it: cancel while live, merge or discard once finished.

const LOG_LINES = 80;
const DIFF_CHARS = 20_000;

interface RunData {
  detail: RunDetailView;
  diff: DiffResult | null;
}

/** One log line, as the run's activity reads at a glance. */
function line(entry: NormalizedEntry): string | null {
  const text = entry.text?.trim() ?? '';
  switch (entry.kind) {
    case 'assistant':
      return text === '' ? null : text;
    case 'tool':
      if (entry.toolName === undefined)
        return entry.status === 'error'
          ? `  failed: ${text.slice(0, 200)}`
          : null;
      return `› ${entry.toolName}${text === '' ? '' : ` ${text.slice(0, 160)}`}`;
    case 'system':
    case 'message':
      return text === '' ? null : `· ${text}`;
    default:
      return null;
  }
}

export default function RunScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { client } = useRemote();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (c: ApiClient): Promise<RunData> => {
    const detail = await c.fetchRun(id);
    const diff =
      detail.meta.state === 'finished'
        ? await c.fetchRunDiff(id).catch(() => null)
        : null;
    return { detail, diff };
  };
  const live = useLive(
    load,
    ['run.changed', 'run.log', 'merge-queue.changed'],
    id
  );

  const act = async (what: (c: ApiClient) => Promise<unknown>) => {
    if (client === null) return;
    setBusy(true);
    setError(null);
    try {
      await what(client);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await live.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const confirm = (title: string, verb: string, run: () => void) =>
    Alert.alert(title, undefined, [
      { text: 'Not now', style: 'cancel' },
      { text: verb, style: 'destructive', onPress: run },
    ]);

  const meta = live.data?.detail.meta;
  const log = (live.data?.detail.entries ?? [])
    .map(line)
    .filter((l): l is string => l !== null)
    .slice(-LOG_LINES);
  const diff = live.data?.diff ?? null;

  return (
    <ScrollView
      refreshControl={
        <RefreshControl
          refreshing={live.loading}
          onRefresh={() => void live.refresh()}
        />
      }
      contentContainerStyle={{ paddingBottom: 32 }}
    >
      <Stack.Screen options={{ title: meta?.taskTitle ?? 'Run' }} />
      <ConnectionNotice />
      {meta === undefined ? (
        live.error === null ? null : (
          <Card>
            <Body>{live.error}</Body>
          </Card>
        )
      ) : (
        <>
          <Card>
            <Title>{stateText(meta)}</Title>
            {meta.error === undefined ? null : <Body>{meta.error}</Body>}
            {meta.prUrl === undefined ? null : <Body muted>{meta.prUrl}</Body>}
            {error === null ? null : <Body>{error}</Body>}
            <Row>
              {isLive(meta) ? (
                <Button
                  label="Cancel run"
                  tone="danger"
                  disabled={busy}
                  onPress={() =>
                    confirm(
                      'Cancel this run?',
                      'Cancel run',
                      () => void act((c) => c.cancelRun(meta.id))
                    )
                  }
                />
              ) : null}
              {awaitsReview(meta) ? (
                <>
                  <Button
                    label="Merge"
                    tone="primary"
                    disabled={busy}
                    onPress={() =>
                      confirm(
                        'Queue this run to merge?',
                        'Merge',
                        () => void act((c) => c.enqueueMergeQueue(meta.id))
                      )
                    }
                  />
                  <Button
                    label="Discard"
                    tone="danger"
                    disabled={busy}
                    onPress={() =>
                      confirm(
                        'Discard this run’s work?',
                        'Discard',
                        () => void act((c) => c.reviewRun(meta.id, 'discard'))
                      )
                    }
                  />
                </>
              ) : null}
            </Row>
          </Card>
          {diff === null ? null : (
            <Card>
              <Title>
                {diff.files.length} {diff.files.length === 1 ? 'file' : 'files'}{' '}
                changed
              </Title>
              <Body mono>
                {diff.files.map((f) => `${f.status} ${f.path}`).join('\n')}
              </Body>
              <Body mono>
                {diff.patch.length > DIFF_CHARS
                  ? `${diff.patch.slice(0, DIFF_CHARS)}\n… the rest is on your Mac`
                  : diff.patch}
              </Body>
            </Card>
          )}
          <Card>
            <Title>Log</Title>
            <Body mono>
              {log.length === 0 ? 'Nothing logged yet.' : log.join('\n')}
            </Body>
          </Card>
        </>
      )}
    </ScrollView>
  );
}
