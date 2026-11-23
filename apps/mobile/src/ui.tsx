import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { statusText, useRemote } from './remote';
import {
  font,
  radius,
  size,
  type Tone,
  toneColours,
  useColours,
} from './theme';

// The app's building blocks, drawn with the desktop's tokens (src/theme.ts):
// warm neutral surfaces, soft hairlines, the purple accent for actions only,
// and status tones for what a thing is waiting on.

/** A card. A tone tints it, the way desktop marks something waiting on you
 *  in amber; untoned cards sit on the plain surface. */
export function Card({ children, tone }: { children: ReactNode; tone?: Tone }) {
  const c = useColours();
  const t = tone === undefined ? null : toneColours(c, tone);
  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: c.surface,
          borderColor: t?.line ?? c.border,
        },
      ]}
    >
      {t === null ? null : (
        <View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { backgroundColor: t.soft }]}
        />
      )}
      {children}
    </View>
  );
}

export function Title({ children }: { children: ReactNode }) {
  const c = useColours();
  return <Text style={[styles.title, { color: c.text }]}>{children}</Text>;
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
  const c = useColours();
  return (
    <Text
      {...(lines === undefined ? {} : { numberOfLines: lines })}
      style={[
        mono ? styles.mono : styles.body,
        { color: muted ? c.text3 : mono ? c.text2 : c.text },
        mono ? { backgroundColor: c.surface2 } : null,
      ]}
    >
      {children}
    </Text>
  );
}

/** Small grey text under a title: when, where from, which run. */
export function Meta({ children }: { children: ReactNode }) {
  const c = useColours();
  return <Text style={[styles.meta, { color: c.text3 }]}>{children}</Text>;
}

/** A status pill: a dot and a word, tinted by tone. */
export function Chip({ label, tone }: { label: string; tone: Tone }) {
  const c = useColours();
  const t = toneColours(c, tone);
  return (
    <View style={[styles.chip, { backgroundColor: t.soft }]}>
      <View style={[styles.dot, { backgroundColor: t.ink }]} />
      <Text style={[styles.chipText, { color: t.ink }]}>{label}</Text>
    </View>
  );
}

type ButtonTone = 'primary' | 'plain' | 'danger';

export function Button({
  label,
  onPress,
  tone = 'plain',
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  tone?: ButtonTone;
  disabled?: boolean;
}) {
  const c = useColours();
  const fill = tone === 'primary' ? c.accent : c.surface;
  const color =
    tone === 'primary' ? c.onAccent : tone === 'danger' ? c.red : c.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: fill,
          borderColor: tone === 'primary' ? c.accent : c.borderStrong,
          opacity: disabled ? 0.45 : pressed ? 0.75 : 1,
        },
      ]}
    >
      <Text style={[styles.buttonText, { color }]}>{label}</Text>
    </Pressable>
  );
}

/** A title with something on its right: a chip, a time. */
export function TitleRow({
  title,
  right,
}: {
  title: ReactNode;
  right: ReactNode;
}) {
  return (
    <View style={styles.titleRow}>
      <View style={{ flex: 1 }}>
        <Title>{title}</Title>
      </View>
      {right}
    </View>
  );
}

/** A small heading over a group of cards, like desktop's section eyebrows. */
export function SectionLabel({ children }: { children: ReactNode }) {
  const c = useColours();
  return <Text style={[styles.section, { color: c.text3 }]}>{children}</Text>;
}

export function Row({ children }: { children: ReactNode }) {
  return <View style={styles.row}>{children}</View>;
}

/** What to show while the link is not ready, or null once it is. */
export function ConnectionNotice() {
  const { status, retry } = useRemote();
  const c = useColours();
  if (status.kind === 'ready') return null;
  const t = toneColours(c, status.kind === 'connecting' ? 'blue' : 'amber');
  return (
    <View
      style={[styles.notice, { backgroundColor: t.soft, borderColor: t.line }]}
    >
      {status.kind === 'connecting' ? (
        <ActivityIndicator color={t.ink} />
      ) : null}
      <Text style={[styles.body, { color: t.ink, flex: 1 }]}>
        {statusText(status)}
      </Text>
      {status.kind === 'connecting' ? null : (
        <Button label="Retry" onPress={retry} />
      )}
    </View>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  const c = useColours();
  return (
    <Text style={[styles.body, styles.empty, { color: c.text3 }]}>
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
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 14,
    marginHorizontal: 16,
    marginTop: 12,
    gap: 8,
    overflow: 'hidden',
  },
  title: {
    fontFamily: font.semibold,
    fontSize: size.heading - 1,
    letterSpacing: -0.1,
  },
  body: { fontFamily: font.regular, fontSize: size.body, lineHeight: 21 },
  meta: { fontFamily: font.regular, fontSize: size.small },
  mono: {
    fontFamily: font.mono,
    fontSize: size.mono,
    lineHeight: 18,
    borderRadius: radius.sm,
    paddingHorizontal: 8,
    paddingVertical: 6,
    overflow: 'hidden',
  },
  section: {
    fontFamily: font.medium,
    fontSize: size.caption,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginHorizontal: 18,
    marginTop: 20,
  },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  button: {
    borderRadius: radius.lg,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  buttonText: { fontFamily: font.medium, fontSize: size.body },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  chipText: { fontFamily: font.medium, fontSize: size.caption },
  notice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    margin: 16,
    marginBottom: 0,
    padding: 12,
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
  },
  empty: { textAlign: 'center', marginTop: 48, marginHorizontal: 32 },
});
