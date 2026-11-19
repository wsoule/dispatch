import { type PairingOffer, toBase64Url } from '@dispatch/remote';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { offerKind } from '../src/macs';
import { readPairingText, urlFromParams } from '../src/pairing';
import { useRemote } from '../src/remote';
import { font, radius, useColours } from '../src/theme';
import { Body, Button, Card, Row, Title } from '../src/ui';

// Pairing: the Mac shows a QR code (Settings › Devices, or `dispatch phone
// pair`), the phone reads
// it, and nothing is trusted until the person taps Pair. A link opened from
// the system camera lands here too, with the same confirm step, so a link
// sent by someone else can never pair this phone on its own.

export default function PairScreen() {
  const { pair, macs } = useRemote();
  const params = useLocalSearchParams();
  const c = useColours();
  const [permission, requestPermission] = useCameraPermissions();
  const [offer, setOffer] = useState<PairingOffer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pasted, setPasted] = useState('');
  const [deviceName, setDeviceName] = useState('iPhone');
  const [busy, setBusy] = useState(false);
  const scanned = useRef(false);

  const read = (text: string) => {
    const parsed = readPairingText(text);
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
    { color: c.text, borderColor: c.controlBorder, backgroundColor: c.surface },
  ];

  if (offer !== null) {
    const kind = offerKind(
      { active: null, macs },
      {
        daemonId: offer.daemonId,
        daemonKey: toBase64Url(offer.daemonKey),
        relay: offer.relay,
      }
    );
    return (
      <ScrollView>
        <Card>
          <Title>Pair with {offer.name}?</Title>
          <Body muted>
            Only pair with a Mac you own. This phone will be able to answer
            agents, cancel runs and merge work there.
          </Body>
          {kind === 'key-changed' ? (
            <Card tone="red">
              <Title>This Mac's keys have changed</Title>
              <Body>
                The code says it is a Mac this phone already knows, but with
                different keys. That happens when Dispatch was reset on that
                Mac, or when someone shows a code made to pass as it. Pair only
                if you just reset it yourself; pairing replaces the old keys.
              </Body>
            </Card>
          ) : kind === 'same' ? (
            <Body muted>
              This phone already knows this Mac. Pairing again renews its
              pairing.
            </Body>
          ) : macs.length === 0 ? null : (
            <Body muted>
              It joins the {macs.length === 1 ? 'Mac' : 'Macs'} this phone
              already knows; switch between them in the Mac tab.
            </Body>
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
          On your Mac, open Dispatch › Settings › Devices and choose Show code
          under iPhone (or run `dispatch phone pair`), then point the camera at
          the code.
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
                if (!readPairingText(result.data).ok)
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
          placeholderTextColor={c.text4}
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
    borderRadius: radius.xl,
    overflow: 'hidden',
    marginTop: 4,
  },
  input: {
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: font.regular,
    fontSize: 15,
  },
});
