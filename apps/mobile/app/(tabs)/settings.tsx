import { router } from 'expo-router';
import { Alert, Pressable, ScrollView, View } from 'react-native';

import { statusText, useRemote } from '../../src/remote';
import {
  Body,
  Button,
  Card,
  Chip,
  Meta,
  Row,
  Title,
  TitleRow,
} from '../../src/ui';

// The Macs this phone is paired with: which one the app is talking to, a tap
// to switch to another, pairing one more, and forgetting one.

export default function Settings() {
  const { paired, macs, status, switchTo, forget, retry } = useRemote();
  const connected = status.kind === 'ready';
  return (
    <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
      <Card>
        <TitleRow
          title={paired?.daemonName ?? 'No Mac paired'}
          right={
            paired === null ? null : (
              <Chip
                label={connected ? 'Connected' : 'Offline'}
                tone={connected ? 'green' : 'amber'}
              />
            )
          }
        />
        <Meta>{statusText(status)}</Meta>
        <Body muted>
          Requests go through the relay encrypted end to end. The relay sees
          only that your phone and Mac are talking, never what they say.
        </Body>
        <Row>
          <Button label="Reconnect" onPress={retry} />
          <Button
            label="Pair another Mac"
            onPress={() => router.push('/pair')}
          />
        </Row>
      </Card>

      {macs.length < 2 ? null : (
        <Card>
          <Title>Your Macs</Title>
          <Meta>Tap one to switch. Each keeps its own keys.</Meta>
          {macs.map((mac) => {
            const current = mac.daemonId === paired?.daemonId;
            return (
              <Pressable
                key={mac.daemonId}
                accessibilityRole="button"
                accessibilityState={{ selected: current }}
                disabled={current}
                onPress={() => void switchTo(mac.daemonId)}
              >
                <View style={{ paddingVertical: 8 }}>
                  <TitleRow
                    title={mac.daemonName}
                    right={
                      current ? <Chip label="In use" tone="accent" /> : null
                    }
                  />
                </View>
              </Pressable>
            );
          })}
        </Card>
      )}

      {paired === null ? null : (
        <Card>
          <Title>Forget {paired.daemonName}</Title>
          <Body muted>
            Removes its keys from this phone
            {macs.length > 1 ? ' and switches to your next Mac' : ''}. Unpair
            the phone on the Mac too (Settings › Devices), so it stops trusting
            this phone.
          </Body>
          <Row>
            <Button
              label="Forget"
              tone="danger"
              onPress={() =>
                Alert.alert(`Forget ${paired.daemonName}?`, undefined, [
                  { text: 'Not now', style: 'cancel' },
                  {
                    text: 'Forget',
                    style: 'destructive',
                    onPress: () => void forget(paired.daemonId),
                  },
                ])
              }
            />
          </Row>
        </Card>
      )}
    </ScrollView>
  );
}
