import type { ComponentProps } from 'react';

import { cn } from '../lib/utils';

export type InitialsAvatarProps = Omit<ComponentProps<'span'>, 'color'> & {
  /** The name the initials are taken from; also the accessible name. */
  name: string;
  /** Background — any CSS colour. Defaults to a hue hashed from the name so the same
   * person always gets the same colour. */
  color?: string;
  /** The 18px rounded-square variant (radius 4) used for the workspace switcher. */
  square?: boolean;
};

// The first letter of the first two words, or the first two letters of a single word,
// so "Wyat Soule" → "WS" and "dispatch" → "DI".
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

// A stable saturated hue per name: a tiny string hash onto the colour wheel.
export function colorFor(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return `oklch(0.62 0.16 ${Math.abs(hash) % 360})`;
}

/** The 18px avatar: two 9px initials in white on a saturated colour. Circle by default,
 * a rounded square for workspaces. */
export function InitialsAvatar({
  name,
  color,
  square = false,
  className,
  ...props
}: InitialsAvatarProps) {
  return (
    <span
      role="img"
      aria-label={name}
      data-slot="initials-avatar"
      className={cn(
        'inline-flex size-[18px] shrink-0 items-center justify-center text-[9px] leading-none font-normal text-white select-none',
        square ? 'rounded-[4px]' : 'rounded-pill',
        className
      )}
      style={{ backgroundColor: color ?? colorFor(name) }}
      {...props}
    >
      {initialsOf(name)}
    </span>
  );
}
