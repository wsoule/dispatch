import { Tabs } from 'expo-router';

import { usePalette } from '../../src/ui';

export default function TabsLayout() {
  const p = usePalette();
  return (
    <Tabs
      screenOptions={{
        sceneStyle: { backgroundColor: p.bg },
        headerStyle: { backgroundColor: p.bg },
        headerTitleStyle: { color: p.text },
        tabBarStyle: { backgroundColor: p.card, borderTopColor: p.border },
        tabBarActiveTintColor: p.accent,
        tabBarInactiveTintColor: p.muted,
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Needs you' }} />
      <Tabs.Screen name="runs" options={{ title: 'Runs' }} />
      <Tabs.Screen name="review" options={{ title: 'Review' }} />
      <Tabs.Screen name="settings" options={{ title: 'Mac' }} />
    </Tabs>
  );
}
