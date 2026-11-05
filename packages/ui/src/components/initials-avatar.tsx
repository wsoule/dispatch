import { User } from 'lucide-react';
import type { ReactNode } from 'react';

import { initials } from '../edit/shared';
import styles from './initials-avatar.module.css';

/** The hues an avatar may be tinted with: tokens.css's decorative hues
    only (never a status hue: red, amber, green and blue mean something),
    in a fixed order so a name always gets the same one. */
export const AVATAR_HUES = ['violet', 'teal', 'rose', 'orange'] as const;

export type AvatarHue = (typeof AVATAR_HUES)[number];

/**
 * The pastel hue of a person's round avatar, picked from their name (a
 * small string hash over code points), so the same person reads the same
 * colour in every list. Decoration only: the name is always printed beside
 * the initials, so the hue never carries meaning on its own. Lower-cased
 * without a locale (toLowerCase), so a Turkish-locale browser hashes "I…"
 * names like the server and hydration agrees.
 */
export function avatarHue(name: string): AvatarHue {
  let hash = 0;
  for (const char of name.trim().toLowerCase()) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 2_147_483_647;
  }
  return AVATAR_HUES[hash % AVATAR_HUES.length] ?? 'violet';
}

/* The person glyph inside an empty (nobody) avatar, per avatar size. */
const EMPTY_ICON_SIZE = { sm: 11, base: 12, md: 14, lg: 18 } as const;

/**
 * A person as Gr8r draws them: a round avatar with their initials on a
 * pastel tint of a hue picked from the name (decoration: the name is
 * always printed beside it, so the avatar is aria-hidden). A blank name is
 * nobody: a dashed empty circle with a person glyph, the way an unassigned
 * slot looks. `size` is 20px (sm) in a picker row or trigger, 22px (base)
 * in the sidebar footer, 26px (md) beside a comment or in a list of
 * people, 36px (lg) as a header. The one avatar of the package and its
 * hosts, so a person reads the same colour everywhere.
 */
export interface InitialsAvatarProps {
  name: string;
  size?: 'sm' | 'base' | 'md' | 'lg';
}

export function InitialsAvatar({
  name,
  size = 'sm',
}: InitialsAvatarProps): ReactNode {
  const empty = name.trim() === '';
  return (
    <span
      className={styles.avatar}
      aria-hidden="true"
      data-mark="avatar"
      data-size={size}
      data-hue={empty ? undefined : avatarHue(name)}
      data-empty={empty ? 'true' : undefined}
    >
      {empty ? (
        <User
          size={EMPTY_ICON_SIZE[size]}
          strokeWidth={1.8}
          aria-hidden="true"
        />
      ) : (
        initials(name)
      )}
    </span>
  );
}
