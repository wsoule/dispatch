import {
  type ComponentType,
  createElement,
  isValidElement,
  type ReactNode,
} from 'react';

import type { ShellIcon, ShellIconProps } from './types';

// Pure render helpers for the shell family. Deliberately not a client
// module: server-rendered components (PropertyList, Kbd, skeletons) call
// these during the server render.

/* Gr8r's Lucide voice: 16px at a 1.8 stroke. */
const ICON_PROPS: ShellIconProps = {
  size: 16,
  strokeWidth: 1.8,
  'aria-hidden': true,
};

/** Renders a ShellIcon: components (lucide icons, which are forwardRef
    objects) get the shell's size and stroke; nodes render as given. */
export function renderIcon(icon: ShellIcon | undefined): ReactNode {
  if (icon === undefined || icon === null || typeof icon === 'boolean') {
    return null;
  }
  if (isValidElement(icon)) return icon;
  if (
    typeof icon === 'function' ||
    (typeof icon === 'object' && '$$typeof' in icon)
  ) {
    return createElement(icon as ComponentType<ShellIconProps>, ICON_PROPS);
  }
  return icon as ReactNode;
}

/** Joins class names, dropping empty ones. */
export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter((n) => typeof n === 'string' && n !== '').join(' ');
}
