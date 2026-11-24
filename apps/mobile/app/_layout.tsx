import { Redirect, Stack, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, View } from 'react-native';

import { useAppFonts } from '../src/fonts';
import { RemoteProvider, useRemote } from '../src/remote';
import { font, useColours } from '../src/theme';

function Gate() {
  const { loaded, paired } = useRemote();
  const segments = useSegments();
  const c = useColours();
  if (!loaded) {
    return (
      <View
        style={{ flex: 1, justifyContent: 'center', backgroundColor: c.bg }}
      >
        <ActivityIndicator />
      </View>
    );
  }
  // Nothing but pairing until this phone has a Mac.
  if (paired === null && segments[0] !== 'pair')
    return <Redirect href="/pair" />;
  return (
    <Stack
      screenOptions={{
        contentStyle: { backgroundColor: c.bg },
        headerStyle: { backgroundColor: c.bg },
        headerShadowVisible: false,
        headerTintColor: c.accentInk,
        headerTitleStyle: { color: c.text, fontFamily: font.semibold },
        headerBackButtonDisplayMode: 'minimal',
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen
        name="pair"
        options={{ title: 'Pair with your Mac', presentation: 'modal' }}
      />
      <Stack.Screen name="run/[id]" options={{ title: 'Run' }} />
    </Stack>
  );
}

export default function RootLayout() {
  // Hold the first frame until Geist is in, so text never reflows from the
  // system font. A failed load lets the app start on the system font.
  const fontsReady = useAppFonts();
  if (!fontsReady) return null;
  return (
    <RemoteProvider>
      <StatusBar style="auto" />
      <Gate />
    </RemoteProvider>
  );
}
