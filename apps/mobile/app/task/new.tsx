import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { useRemote } from '../../src/remote';
import { draftFromParams, taskFromText } from '../../src/tasks';
import { font, radius, size, useColours } from '../../src/theme';
import { Body, Button, ConnectionNotice, Meta, Row } from '../../src/ui';

// A task typed on the phone: the first line is its title, the rest its
// description. Save puts it on the board as ready; Save and start also starts
// a run on it and opens that run.
//
// A `dispatch-remote://task/new?title=…&url=…` link (an iOS Shortcut on the
// share sheet) opens this screen filled in. It only ever fills in the text:
// nothing is saved or started until someone taps.

export default function NewTask() {
  const params = useLocalSearchParams();
  const { client, status } = useRemote();
  const c = useColours();
  const [text, setText] = useState(() => draftFromParams(params));
  const [busy, setBusy] = useState<'save' | 'start' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const leave = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/runs');
  };

  const save = async (andStart: boolean) => {
    const task = taskFromText(text);
    if (!task.ok) {
      setError(task.error);
      return;
    }
    if (client === null) return;
    setBusy(andStart ? 'start' : 'save');
    setError(null);
    try {
      const doc = await client.createTask(task.input);
      if (andStart) {
        const run = await client
          .createRun(doc.meta.id)
          .catch((err: unknown) => {
            // The task is saved either way; say so rather than lose it.
            throw new Error(
              `Saved as ${doc.meta.id}, but it did not start: ${err instanceof Error ? err.message : String(err)}`
            );
          });
        void Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Success
        );
        router.replace({ pathname: '/run/[id]', params: { id: run.id } });
        return;
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      leave();
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const empty = text.trim() === '';
  const disabled = busy !== null || status.kind !== 'ready' || empty;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: 32 }}
      >
        <ConnectionNotice />
        <View style={s.body}>
          <TextInput
            value={text}
            onChangeText={(next) => {
              setText(next);
              if (error !== null) setError(null);
            }}
            placeholder={'What needs doing?\n\nAdd details on the lines below.'}
            placeholderTextColor={c.text4}
            multiline
            // The screen is only this field, opened by asking to write a
            // task: an iOS compose sheet opens with the keyboard up.
            // oxlint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            textAlignVertical="top"
            style={[
              s.input,
              {
                color: c.text,
                backgroundColor: c.surface,
                borderColor: c.border,
              },
            ]}
          />
          <Meta>
            The first line is the title. It goes on the board as ready to start.
          </Meta>
          {error === null ? null : <Body>{error}</Body>}
          <Row>
            <Button
              label={busy === 'start' ? 'Starting…' : 'Save and start'}
              tone="primary"
              disabled={disabled}
              onPress={() => void save(true)}
            />
            <Button
              label={busy === 'save' ? 'Saving…' : 'Save'}
              disabled={disabled}
              onPress={() => void save(false)}
            />
          </Row>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  body: { marginHorizontal: 16, marginTop: 12, gap: 10 },
  input: {
    minHeight: 180,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.xl,
    padding: 14,
    fontFamily: font.regular,
    fontSize: size.body,
    lineHeight: 21,
  },
});
