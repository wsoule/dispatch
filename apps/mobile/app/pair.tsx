import { type PairingOffer, parsePairingUrl } from '@dispatch/remote';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { urlFromParams } from '../src/pairing';
import { useRemote } from '../src/remote';
import { Body, Button, Card, Row, Title, usePalette } from '../src/ui';

// Pairing: the Mac shows a QR code (`dispatch phone pair`), the phone reads
// it, and nothing is trusted until the person taps Pair. A link opened from
// the system camera lands here too, with the same confirm step, so a link
// sent by someone else can never pair this phone on its own.

export default function PairScreen() {
  const { pair, paired } = useRemote();
  const params = useLocalSearchParams();
  const p = usePalette();
  const [permission, requestPermission] = useCameraPermissions();
  const [offer, setOffer] = useState<PairingOffer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pasted, setPasted] = useState('');
  const [deviceName, setDeviceName] = useState('iPhone');
  const [busy, setBusy] = useState(false);
  const scanned = useRef(false);

  const read = (text: string) => {
    const parsed = parsePairingUrl(text.trim());
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(null);
    setOffer(parsed.offer);
  };

  const fromLink = urlFromParams(params);
  useEffect(() => {
    if (fromLink !== null) read(fromLink);
  }, [fromLink]);

  const confirm = async () => {
    if (offer === null) return;
    setBusy(true);
    setError(null);
    try {
      await pair(
        offer,
        deviceName.trim() === '' ? 'iPhone' : deviceName.trim()
      );
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      scanned.current = false;
    } finally {
      setBusy(false);
    }
  };

  const inputStyle = [
    styles.input,
    { color: p.text, borderColor: p.border, backgroundColor: p.card },
  ];

  if (offer !== null) {
    return (
      <ScrollView>
        <Card>
          <Title>Pair with {offer.name}?</Title>
          <Body muted>
            Only pair with a Mac you own. This phone will be able to answer
            agents, cancel runs and merge work there.
          </Body>
          {paired === null ? null : (
            <Body muted>This replaces {paired.daemonName} on this phone.</Body>
          )}
          <Body muted>Name this phone</Body>
          <TextInput
            value={deviceName}
            onChangeText={setDeviceName}
            style={inputStyle}
            maxLength={64}
            autoCorrect={false}
          />
          {error === null ? null : <Body>{error}</Body>}
          <Row>
            <Button
              label={busy ? 'Pairing…' : 'Pair'}
              tone="primary"
              disabled={busy}
              onPress={() => void confirm()}
            />
            <Button
              label="Cancel"
              disabled={busy}
              onPress={() => {
                setOffer(null);
                scanned.current = false;
              }}
            />
          </Row>
        </Card>
      </ScrollView>
    );
  }

  return (
    <ScrollView>
      <Card>
        <Title>Scan the code on your Mac</Title>
        <Body muted>
          Run `dispatch phone pair` in your project and point the camera at the
          code.
        </Body>
        {permission?.granted === true ? (
          <View style={styles.camera}>
            <CameraView
              style={StyleSheet.absoluteFill}
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={(result) => {
                if (scanned.current) return;
                scanned.current = true;
                read(result.data);
                if (!parsePairingUrl(result.data.trim()).ok)
                  setTimeout(() => (scanned.current = false), 1500);
              }}
            />
          </View>
        ) : (
          <Row>
            <Button
              label="Use the camera"
              tone="primary"
              onPress={() => void requestPermission()}
            />
          </Row>
        )}
        {permission?.canAskAgain === false && permission.granted !== true ? (
          <Body muted>Camera access is off for Dispatch in Settings.</Body>
        ) : null}
      </Card>
      <Card>
        <Title>Or paste the pairing link</Title>
        <TextInput
          value={pasted}
          onChangeText={setPasted}
          placeholder="dispatch-remote://pair?…"
          placeholderTextColor={p.muted}
          style={inputStyle}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Row>
          <Button label="Continue" onPress={() => read(pasted)} />
        </Row>
        {error === null ? null : <Body>{error}</Body>}
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  camera: {
    height: 280,
    borderRadius: 12,
    overflow: 'hidden',
    marginTop: 4,
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
});
