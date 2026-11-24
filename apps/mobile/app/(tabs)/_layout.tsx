import type { ApiClient } from '@dispatch/client';
import { Tabs } from 'expo-router';

import { useLive } from '../../src/live';
import { font, size, useColours } from '../../src/theme';

const countOpen = (client: ApiClient) =>
  client.openDecisions().then((r) => r.items.length);

export default function TabsLayout() {
  const c = useColours();
  // The Needs you count as the tab's badge, in amber: waiting on you.
  const open = useLive(countOpen, ['decisions.changed', 'inbox.changed']);
  const badge = (open.data ?? 0) > 0 ? open.data : undefined;
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
      <Tabs.Screen
        name="index"
        options={{
          title: 'Needs you',
          ...(badge === undefined ? {} : { tabBarBadge: badge }),
          tabBarBadgeStyle: {
            backgroundColor: c.amber,
            color: c.onRed,
            fontFamily: font.semibold,
          },
        }}
      />
      <Tabs.Screen name="runs" options={{ title: 'Runs' }} />
      <Tabs.Screen name="overseer" options={{ title: 'Overseer' }} />
      <Tabs.Screen name="review" options={{ title: 'Review' }} />
      <Tabs.Screen name="settings" options={{ title: 'Mac' }} />
    </Tabs>
  );
}
