import { Redirect, Stack, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, View } from 'react-native';

import { RemoteProvider, useRemote } from '../src/remote';
import { usePalette } from '../src/ui';

function Gate() {
  const { loaded, paired } = useRemote();
  const segments = useSegments();
  const p = usePalette();
  if (!loaded) {
    return (
      <View
        style={{ flex: 1, justifyContent: 'center', backgroundColor: p.bg }}
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
        contentStyle: { backgroundColor: p.bg },
        headerStyle: { backgroundColor: p.bg },
        headerTintColor: p.accent,
        headerTitleStyle: { color: p.text },
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
  return (
    <RemoteProvider>
      <StatusBar style="auto" />
      <Gate />
    </RemoteProvider>
  );
}
