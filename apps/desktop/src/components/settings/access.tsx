import type { AuthTier } from '@dispatch/client';
import type { ReactNode } from 'react';
import { createContext, useContext } from 'react';

// What the viewer may change in Settings, mirroring the daemon's own rules:
// every config save (PATCH /api/config) needs the decide tier, and the keys
// that run commands or send data elsewhere need operator on top. The shell
// provides it once; groups and rows read it so no control can be left
// editable for someone the server will refuse.

export interface SettingsAccess {
  /** May save config at all (decide tier or above). */
  canDecide: boolean;
  /** May change the operator-only keys too. */
  canOperate: boolean;
  /** Why config is read-only, shown beside a locked group and atop the page. */
  decideReason: string;
  /** Why an operator-only setting is read-only, shown beside its row. */
  operateReason: string;
}

/** Why config is read-only for a teammate below the decide tier. */
export const NEEDS_DECIDE =
  'Changing settings needs Can approve access. Ask the person running Dispatch for this project.';

/** Why an operator-only setting is read-only for everyone else. */
export const OPERATOR_ONLY =
  'Only the person running Dispatch for this project can change this, because it runs commands on their machine or sends data elsewhere.';

/** Why config is read-only for the owner's own window when it attached to a
 *  daemon it did not start, and so holds only the request-tier token. */
export const ATTACHED_READ_ONLY =
  'Dispatch for this project was started outside this window (by dispatch serve, a CLI command or another window), so this window can only view settings. Restart Dispatch from this app to change them.';

/** The same, when the daemon file says the CLI started it in the background. */
export const ATTACHED_BACKGROUND_READ_ONLY =
  'Dispatch for this project is running in the background, started by a `dispatch` CLI command, so this window can only view settings. Restart Dispatch from this app to change them.';

// Outside a shell (a section rendered on its own, as the section tests do)
// nothing is locked, which is what those callers have always assumed.
const AccessContext = createContext<SettingsAccess>({
  canDecide: true,
  canOperate: true,
  decideReason: NEEDS_DECIDE,
  operateReason: OPERATOR_ONLY,
});

/** The access a viewer at `tier` has. `null` (no connection) grants nothing. */
export function accessFor(
  tier: AuthTier | null,
  attachedWithoutAppToken: boolean,
  background = false
): SettingsAccess {
  const attached = background
    ? ATTACHED_BACKGROUND_READ_ONLY
    : ATTACHED_READ_ONLY;
  return {
    canDecide: tier === 'decide' || tier === 'operator',
    canOperate: tier === 'operator',
    decideReason: attachedWithoutAppToken ? attached : NEEDS_DECIDE,
    // Restarting from the app grants the owner operator, so it covers both.
    operateReason: attachedWithoutAppToken ? attached : OPERATOR_ONLY,
  };
}

export function SettingsAccessProvider({
  access,
  children,
}: {
  access: SettingsAccess;
  children: ReactNode;
}) {
  return (
    <AccessContext.Provider value={access}>{children}</AccessContext.Provider>
  );
}

export function useSettingsAccess(): SettingsAccess {
  return useContext(AccessContext);
}
