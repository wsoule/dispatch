import type { ApiClient, Message, ReplyInput } from '@dispatch/client';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useState } from 'react';
import { FlatList, RefreshControl, TextInput } from 'react-native';

import { decisionCard } from '../../src/decisions';
import { useLive } from '../../src/live';
import { useRemote } from '../../src/remote';
import { radius, useColours } from '../../src/theme';
import {
  ago,
  Body,
  Button,
  Card,
  ConnectionNotice,
  Empty,
  Meta,
  Row,
  styles,
  TitleRow,
} from '../../src/ui';

// Everything an agent is blocked on and asking this person: a tool call to
// approve, files outside a run's scope, or a question. Each answer is a
// reply to the gate's message, the same one the desktop app sends. What each
// card shows and sends comes from src/decisions.ts.

const load = (client: ApiClient) => client.openDecisions().then((r) => r.items);

function Decision({
  message,
  answer,
}: {
  message: Message;
  answer: (id: string, reply: ReplyInput) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const c = useColours();
  const card = decisionCard(message);

  const send = async (reply: ReplyInput) => {
    setBusy(true);
    setError(null);
    try {
      await answer(message.id, reply);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <Card tone="amber">
      <TitleRow
        title={card.title}
        right={<Meta>{ago(message.createdAt)}</Meta>}
      />
      {card.body === '' ? null : <Body>{card.body}</Body>}
      {card.code === null ? null : (
        <Body mono lines={8}>
          {card.code}
        </Body>
      )}
      {card.truncated ? <Meta>Only part of the input is shown.</Meta> : null}
      {card.actions.length === 0 ? null : (
        <Row>
          {card.actions.map((action) => (
            <Button
              key={action.label}
              label={action.label}
              tone={action.tone}
              disabled={busy}
              onPress={() => void send(action.reply)}
            />
          ))}
        </Row>
      )}
      {card.freeText ? (
        <>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="Answer in your own words"
            placeholderTextColor={c.text4}
            multiline
            style={[
              styles.body,
              {
                color: c.text,
                backgroundColor: c.surface,
                borderColor: c.controlBorder,
                borderWidth: 1,
                borderRadius: radius.lg,
                padding: 10,
                minHeight: 44,
              },
            ]}
          />
          <Row>
            <Button
              label="Send"
              tone="primary"
              disabled={busy || text.trim() === ''}
              onPress={() => void send({ body: text.trim() })}
            />
          </Row>
        </>
      ) : null}
      {error === null ? null : <Body>{error}</Body>}
      {card.runId === null ? null : (
        <Row>
          <Button
            label="Open run"
            onPress={() => {
              const id = card.runId;
              if (id !== null)
                router.push({ pathname: '/run/[id]', params: { id } });
            }}
          />
        </Row>
      )}
    </Card>
  );
}

export default function NeedsYou() {
  const { client } = useRemote();
  const live = useLive(load, ['decisions.changed', 'inbox.changed']);
  const items = live.data ?? [];

  const answer = async (id: string, reply: ReplyInput) => {
    if (client === null) throw new Error('Not connected');
    await client.replyToMessage(id, reply);
    await live.refresh();
  };

  return (
    <FlatList
      data={items}
      keyExtractor={(m) => m.id}
      ListHeaderComponent={<ConnectionNotice />}
      renderItem={({ item }) => <Decision message={item} answer={answer} />}
      ListEmptyComponent={
        live.data === undefined ? undefined : (
          <Empty>
            {live.error ??
              'Nothing needs you. Agents will ask here when they do.'}
          </Empty>
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
