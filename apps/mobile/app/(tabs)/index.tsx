import {
  type ApiClient,
  approvalReply,
  type Message,
  type ReplyInput,
  runIdOf,
  toolApprovalOf,
  toRunQuestion,
  toScopeRequest,
} from '@dispatch/client';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useState } from 'react';
import { FlatList, RefreshControl, TextInput } from 'react-native';

import { useLive } from '../../src/live';
import { useRemote } from '../../src/remote';
import {
  ago,
  Body,
  Button,
  Card,
  ConnectionNotice,
  Empty,
  Row,
  styles,
  Title,
  usePalette,
} from '../../src/ui';

// Everything an agent is blocked on and asking this person: a tool call to
// approve, files outside a run's scope, or a question. Each answer is a
// reply to the gate's message, the same one the desktop app sends.

const load = (client: ApiClient) => client.openDecisions().then((r) => r.items);

/** A short look at a tool call's input: a command, a path, or the JSON. */
function preview(input: unknown): string {
  if (input !== null && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    for (const key of ['command', 'file_path', 'path', 'url', 'pattern']) {
      const value = record[key];
      if (typeof value === 'string') return value;
    }
  }
  const text = JSON.stringify(input) ?? '';
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

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
  const p = usePalette();
  const runId = runIdOf(message);

  const send = async (reply: ReplyInput) => {
    setBusy(true);
    setError(null);
    try {
      await answer(message.id, reply);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const footer = (
    <>
      {error === null ? null : <Body>{error}</Body>}
      {runId === null ? null : (
        <Row>
          <Button
            label="Open run"
            onPress={() =>
              router.push({ pathname: '/run/[id]', params: { id: runId } })
            }
          />
        </Row>
      )}
    </>
  );

  const approval = toolApprovalOf(message);
  if (approval !== null) {
    return (
      <Card>
        <Title>Allow {approval.tool}?</Title>
        <Body mono lines={8}>
          {preview(approval.input)}
        </Body>
        {approval.truncated === true ? (
          <Body muted>Only part of the input is shown.</Body>
        ) : null}
        <Body muted>{ago(message.createdAt)}</Body>
        <Row>
          <Button
            label="Allow"
            tone="primary"
            disabled={busy}
            onPress={() => void send(approvalReply(true))}
          />
          {/* As on the desktop: offered only when the gate allows it, which a
              call held by the irreversibility floor never does. */}
          {(message.choices?.includes('approve-session') ?? true) ? (
            <Button
              label="Allow for run"
              disabled={busy}
              onPress={() =>
                void send(approvalReply(true, { scope: 'session' }))
              }
            />
          ) : null}
          <Button
            label="Deny"
            tone="danger"
            disabled={busy}
            onPress={() => void send(approvalReply(false))}
          />
        </Row>
        {footer}
      </Card>
    );
  }

  const scope = toScopeRequest(message);
  if (scope !== null) {
    return (
      <Card>
        <Title>Let the run edit outside its scope?</Title>
        <Body>{scope.reason}</Body>
        <Body mono lines={8}>
          {scope.paths.join('\n')}
        </Body>
        <Body muted>{ago(message.createdAt)}</Body>
        <Row>
          <Button
            label="Grant"
            tone="primary"
            disabled={busy}
            onPress={() => void send({ body: '', choice: 'grant' })}
          />
          <Button
            label="Deny"
            tone="danger"
            disabled={busy}
            onPress={() => void send({ body: '', choice: 'deny' })}
          />
        </Row>
        {footer}
      </Card>
    );
  }

  const question = toRunQuestion(message);
  const options = question?.options ?? message.choices ?? [];
  return (
    <Card>
      <Title>{question === null ? `From ${message.from}` : 'A run asks'}</Title>
      <Body>{message.body}</Body>
      <Body muted>{ago(message.createdAt)}</Body>
      {options.length === 0 ? null : (
        <Row>
          {options.map((choice) => (
            <Button
              key={choice}
              label={choice}
              disabled={busy}
              onPress={() => void send({ body: choice, choice })}
            />
          ))}
        </Row>
      )}
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder="Answer in your own words"
        placeholderTextColor={p.muted}
        multiline
        style={[
          styles.body,
          {
            color: p.text,
            borderColor: p.border,
            borderWidth: 1,
            borderRadius: 8,
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
      {footer}
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
