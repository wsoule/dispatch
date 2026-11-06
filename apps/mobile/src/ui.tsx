import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from 'react-native';

import { statusText, useRemote } from './remote';

export interface Palette {
  bg: string;
  card: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
  danger: string;
  good: string;
}

const LIGHT: Palette = {
  bg: '#f2f2f7',
  card: '#ffffff',
  text: '#111114',
  muted: '#6b6b74',
  border: '#d9d9de',
  accent: '#3a5bd9',
  danger: '#c8312f',
  good: '#2f8a4a',
};

const DARK: Palette = {
  bg: '#000000',
  card: '#1c1c1f',
  text: '#f4f4f6',
  muted: '#9a9aa3',
  border: '#2e2e33',
  accent: '#7d95ff',
  danger: '#ff6b66',
  good: '#5fcf7f',
};

export function usePalette(): Palette {
  return useColorScheme() === 'dark' ? DARK : LIGHT;
}

export function Card({ children }: { children: ReactNode }) {
  const p = usePalette();
  return (
    <View
      style={[styles.card, { backgroundColor: p.card, borderColor: p.border }]}
    >
      {children}
    </View>
  );
}

export function Title({ children }: { children: ReactNode }) {
  const p = usePalette();
  return <Text style={[styles.title, { color: p.text }]}>{children}</Text>;
}

export function Body({
  children,
  muted = false,
  mono = false,
  lines,
}: {
  children: ReactNode;
  muted?: boolean;
  mono?: boolean;
  lines?: number;
}) {
  const p = usePalette();
  return (
    <Text
      {...(lines === undefined ? {} : { numberOfLines: lines })}
      style={[
        styles.body,
        { color: muted ? p.muted : p.text },
        mono ? styles.mono : null,
      ]}
    >
      {children}
    </Text>
  );
}

type Tone = 'primary' | 'plain' | 'danger';

export function Button({
  label,
  onPress,
  tone = 'plain',
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  tone?: Tone;
  disabled?: boolean;
}) {
  const p = usePalette();
  const fill = tone === 'primary' ? p.accent : 'transparent';
  const color =
    tone === 'primary' ? '#ffffff' : tone === 'danger' ? p.danger : p.accent;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: fill,
          borderColor: tone === 'primary' ? p.accent : p.border,
          opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
        },
      ]}
    >
      <Text style={[styles.buttonText, { color }]}>{label}</Text>
    </Pressable>
  );
}

export function Row({ children }: { children: ReactNode }) {
  return <View style={styles.row}>{children}</View>;
}

/** What to show while the link is not ready, or null once it is. */
export function ConnectionNotice() {
  const { status, retry } = useRemote();
  const p = usePalette();
  if (status.kind === 'ready') return null;
  return (
    <View
      style={[
        styles.notice,
        { backgroundColor: p.card, borderColor: p.border },
      ]}
    >
      {status.kind === 'connecting' ? <ActivityIndicator /> : null}
      <Text style={[styles.body, { color: p.muted, flex: 1 }]}>
        {statusText(status)}
      </Text>
      {status.kind === 'connecting' ? null : (
        <Button label="Retry" onPress={retry} />
      )}
    </View>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  const p = usePalette();
  return (
    <Text style={[styles.body, styles.empty, { color: p.muted }]}>
      {children}
    </Text>
  );
}

/** "3m ago", "2h ago": how long something has waited. */
export function ago(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export const styles = StyleSheet.create({
  card: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 14,
    marginHorizontal: 16,
    marginTop: 12,
    gap: 8,
  },
  title: { fontSize: 16, fontWeight: '600' },
  body: { fontSize: 15, lineHeight: 20 },
  mono: { fontFamily: 'Menlo', fontSize: 12, lineHeight: 16 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  button: {
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  buttonText: { fontSize: 15, fontWeight: '600' },
  notice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    margin: 16,
    marginBottom: 0,
    padding: 12,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  empty: { textAlign: 'center', marginTop: 48, marginHorizontal: 32 },
});
