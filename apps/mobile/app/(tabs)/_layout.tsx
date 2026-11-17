import { Tabs } from 'expo-router';

import { font, size, useColours } from '../../src/theme';

export default function TabsLayout() {
  const c = useColours();
  return (
    <Tabs
      screenOptions={{
        sceneStyle: { backgroundColor: c.bg },
        headerStyle: { backgroundColor: c.bg },
        headerShadowVisible: false,
        headerTitleAlign: 'left',
        headerTitleStyle: {
          color: c.text,
          fontFamily: font.semibold,
          fontSize: size.title,
        },
        tabBarStyle: { backgroundColor: c.surface, borderTopColor: c.border },
        tabBarActiveTintColor: c.accentInk,
        tabBarInactiveTintColor: c.text3,
        tabBarLabelStyle: { fontFamily: font.medium },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Needs you' }} />
      <Tabs.Screen name="runs" options={{ title: 'Runs' }} />
      <Tabs.Screen name="review" options={{ title: 'Review' }} />
      <Tabs.Screen name="settings" options={{ title: 'Mac' }} />
    </Tabs>
  );
}
