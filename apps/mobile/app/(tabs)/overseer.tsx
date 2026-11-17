import { buildOverseerThread, type OverseerThreadItem } from '@dispatch/client';
import * as Haptics from 'expo-haptics';
import { useNavigation } from 'expo-router';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import type { OverseerCardRef } from '../../src/overseer';
import { font, radius, size, toneColours, useColours } from '../../src/theme';
import {
  Body,
  Button,
  Card,
  ConnectionNotice,
  Empty,
  Meta,
  Row,
  TitleRow,
} from '../../src/ui';
import { useOverseer } from '../../src/useOverseer';

// The Overseer on the phone: the daemon's current conversation, the same rows
// the desktop chat shows (buildOverseerThread), and a box to type in. Its
// proposed actions and the tool calls it parks on are native cards answered
// here; replies stream in as the model writes them. Dictation is the
// keyboard's own microphone.

const OUTCOME_TONE = {
  applied: 'green',
  allowed: 'green',
  denied: 'gray',
  failed: 'red',
} as const;

function Line({
  item,
  deciding,
  decide,
}: {
  item: OverseerThreadItem;
  deciding: string | null;
  decide: (card: OverseerCardRef, yes: boolean) => void;
}) {
  const c = useColours();
  switch (item.kind) {
    case 'message':
      return item.role === 'user' ? (
        <View style={[s.bubble, { backgroundColor: c.surface3 }]}>
          <Text style={[s.text, { color: c.text }]}>{item.text}</Text>
        </View>
      ) : (
        <Text style={[s.text, s.say, { color: c.text }]}>{item.text}</Text>
      );
    case 'live':
      return (
        <Text style={[s.text, s.say, { color: c.text }]}>{item.text}</Text>
      );
    case 'narration':
      return (
        <Text style={[s.text, s.say, { color: c.text2 }]}>{item.text}</Text>
      );
    case 'tool':
      return (
        <Text
          numberOfLines={2}
          style={[s.tool, { color: item.state === 'failed' ? c.red : c.text3 }]}
        >
          › {item.tool}
          {item.text === '' ? '' : ` ${item.text}`}
        </Text>
      );
    case 'outcome': {
      const t = toneColours(c, OUTCOME_TONE[item.outcome]);
      return (
        <Text numberOfLines={3} style={[s.meta, { color: t.ink }]}>
          {item.text}
        </Text>
      );
    }
    case 'confirm': {
      const busy = deciding === item.action.id;
      const card: OverseerCardRef = {
        kind: 'action',
        actionId: item.action.id,
      };
      return (
        <Card tone="amber">
          <TitleRow
            title="The Overseer wants to"
            right={<Meta>{item.action.tool}</Meta>}
          />
          <Body>{item.action.summary}</Body>
          <Row>
            <Button
              label="Confirm"
              tone="primary"
              disabled={deciding !== null}
              onPress={() => decide(card, true)}
            />
            <Button
              label="Cancel"
              tone="danger"
              disabled={deciding !== null}
              onPress={() => decide(card, false)}
            />
            {busy ? <ActivityIndicator /> : null}
          </Row>
        </Card>
      );
    }
    case 'approve': {
      const busy = deciding === item.approval.requestId;
      const card: OverseerCardRef = {
        kind: 'approval',
        requestId: item.approval.requestId,
      };
      return (
        <Card tone="amber">
          <TitleRow title={`Allow ${item.approval.toolName}?`} right={null} />
          <Body mono lines={6}>
            {item.approval.summary}
          </Body>
          <Row>
            <Button
              label="Allow"
              tone="primary"
              disabled={deciding !== null}
              onPress={() => decide(card, true)}
            />
            <Button
              label="Deny"
              tone="danger"
              disabled={deciding !== null}
              onPress={() => decide(card, false)}
            />
            {busy ? <ActivityIndicator /> : null}
          </Row>
        </Card>
      );
    }
    case 'pending':
      return (
        <View style={s.working}>
          <ActivityIndicator size="small" color={c.blue} />
          <Text style={[s.meta, { color: c.text3 }]}>Working…</Text>
        </View>
      );
    case 'failed':
      return <Text style={[s.meta, { color: c.red }]}>{item.error}</Text>;
    case 'notice':
      return (
        <View style={s.notice}>
          <View style={[s.rule, { backgroundColor: c.border }]} />
          <Text style={[s.meta, { color: c.text3 }]}>{item.text}</Text>
          <View style={[s.rule, { backgroundColor: c.border }]} />
        </View>
      );
    case 'door':
      return (
        <Text style={[s.meta, { color: c.text3 }]}>
          Opened {item.door.url ?? 'Tasks'} on the Mac
        </Text>
      );
  }
}

export default function Overseer() {
  const view = useOverseer();
  const c = useColours();
  const navigation = useNavigation();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = useRef<FlatList<OverseerThreadItem>>(null);

  const rows = useMemo(
    () => buildOverseerThread(view.record, view.live),
    [view.record, view.live]
  );
  const running = view.record?.state === 'running';

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () =>
        view.record === undefined ? null : (
          <Pressable
            accessibilityRole="button"
            onPress={view.startOver}
            style={{ paddingHorizontal: 16 }}
          >
            <Text style={{ color: c.accentInk, fontFamily: font.medium }}>
              New
            </Text>
          </Pressable>
        ),
    });
  }, [navigation, view.record, view.startOver, c.accentInk]);

  const fail = (err: unknown) => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    setError(err instanceof Error ? err.message : String(err));
  };

  const send = async () => {
    const line = text.trim();
    if (line === '') return;
    setSending(true);
    setError(null);
    try {
      await view.send(line);
      setText('');
    } catch (err) {
      fail(err);
    } finally {
      setSending(false);
    }
  };

  const decide = (card: OverseerCardRef, yes: boolean) => {
    setError(null);
    view
      .decide(card, yes)
      .then(
        () =>
          void Haptics.notificationAsync(
            Haptics.NotificationFeedbackType.Success
          ),
        fail
      );
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior="padding"
      keyboardVerticalOffset={100}
    >
      <FlatList
        ref={list}
        data={rows}
        keyExtractor={(item) => item.key}
        ListHeaderComponent={<ConnectionNotice />}
        renderItem={({ item }) => (
          <View style={s.row}>
            <Line item={item} deciding={view.deciding} decide={decide} />
          </View>
        )}
        ListEmptyComponent={
          view.loaded ? (
            <Empty>
              {view.error ??
                'Ask the Overseer anything: what is stuck, what landed, what to start next.'}
            </Empty>
          ) : (
            <ActivityIndicator style={{ marginTop: 48 }} />
          )
        }
        onContentSizeChange={() =>
          list.current?.scrollToEnd({ animated: true })
        }
        keyboardDismissMode="interactive"
        contentContainerStyle={{ paddingBottom: 12 }}
      />
      {error === null ? null : (
        <Text style={[s.meta, s.error, { color: c.red }]}>{error}</Text>
      )}
      <View
        style={[
          s.composer,
          { backgroundColor: c.surface, borderColor: c.borderStrong },
        ]}
      >
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={
            view.record === undefined
              ? 'Ask the Overseer…'
              : 'Reply to the Overseer…'
          }
          placeholderTextColor={c.text4}
          multiline
          style={[s.input, { color: c.text }]}
        />
        {running && text.trim() === '' ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Stop"
            onPress={() => void view.stop().catch(fail)}
            style={[s.send, { backgroundColor: c.surface3 }]}
          >
            <View style={[s.stopGlyph, { backgroundColor: c.text }]} />
          </Pressable>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send"
            disabled={sending || text.trim() === ''}
            onPress={() => void send()}
            style={[
              s.send,
              {
                backgroundColor: c.accent,
                opacity: sending || text.trim() === '' ? 0.4 : 1,
              },
            ]}
          >
            <Text style={[s.sendGlyph, { color: c.onAccent }]}>↑</Text>
          </Pressable>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  row: { marginTop: 10 },
  text: { fontFamily: font.regular, fontSize: size.body, lineHeight: 22 },
  say: { marginHorizontal: 16 },
  bubble: {
    alignSelf: 'flex-end',
    maxWidth: '82%',
    marginHorizontal: 16,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
    borderBottomRightRadius: 4,
  },
  tool: {
    fontFamily: font.mono,
    fontSize: size.mono,
    marginHorizontal: 16,
  },
  meta: {
    fontFamily: font.regular,
    fontSize: size.small,
    marginHorizontal: 16,
  },
  working: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
  },
  notice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
  },
  rule: { flex: 1, height: StyleSheet.hairlineWidth },
  error: { marginBottom: 6 },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    marginHorizontal: 12,
    marginBottom: 10,
    paddingLeft: 14,
    paddingRight: 6,
    paddingVertical: 6,
    borderWidth: 1,
    borderRadius: radius.xl * 2,
  },
  input: {
    flex: 1,
    fontFamily: font.regular,
    fontSize: size.body,
    maxHeight: 120,
    paddingTop: 8,
    paddingBottom: 8,
  },
  send: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendGlyph: { fontFamily: font.semibold, fontSize: 18 },
  stopGlyph: { width: 12, height: 12, borderRadius: 2 },
});
