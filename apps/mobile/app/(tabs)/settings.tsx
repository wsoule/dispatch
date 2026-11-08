import { router } from 'expo-router';
import { Alert, ScrollView } from 'react-native';

import { statusText, useRemote } from '../../src/remote';
import { Body, Button, Card, Row, Title } from '../../src/ui';

export default function Settings() {
  const { paired, status, forget, retry } = useRemote();
  return (
    <ScrollView>
      <Card>
        <Title>{paired?.daemonName ?? 'No Mac paired'}</Title>
        <Body muted>{statusText(status)}</Body>
        <Body muted>
          Requests go through the relay encrypted end to end. The relay sees
          only that your phone and Mac are talking, never what they say.
        </Body>
        <Row>
          <Button label="Reconnect" onPress={retry} />
          <Button label="Pair again" onPress={() => router.push('/pair')} />
        </Row>
      </Card>
      {paired === null ? null : (
        <Card>
          <Title>Forget this Mac</Title>
          <Body muted>
            Removes the keys from this phone. Run `dispatch phone unpair` on the
            Mac too, so it stops trusting this phone.
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
                    onPress: () => void forget(),
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
