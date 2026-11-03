import { Spinner } from '@dispatch/ui';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

import { describeError } from '../../lib/actionFeedback';
import {
  clearTeamSession,
  isTeamLocalPage,
  readTeamSession,
  saveTeamSession,
} from '../../lib/teamLocal';
import { checkTeamSession, SignInView } from '../../views/SignInView';
import { GateFrame } from './GateFrame';
import styles from './TeamLocalGate.module.css';

interface TeamLocalGateProps {
  children: ReactNode;
}

/**
 * Stands in front of the whole app on a page a team-local daemon served, and
 * is a no-op everywhere else — the desktop app, a solo browser tab, the demo.
 *
 * Split in two so the hooks below only ever run on a team-local page, instead
 * of one component whose hooks sit behind a condition.
 */
export function TeamLocalGate({ children }: TeamLocalGateProps) {
  return isTeamLocalPage() ? (
    <TeamLocalSignIn>{children}</TeamLocalSignIn>
  ) : (
    <>{children}</>
  );
}

type GateState = 'checking' | 'signed-in' | 'signed-out';

function TeamLocalSignIn({ children }: TeamLocalGateProps) {
  const [state, setState] = useState<GateState>(() =>
    readTeamSession() === null ? 'signed-out' : 'checking'
  );
  const [notice, setNotice] = useState<string | null>(null);

  // A stored session is re-checked on every load rather than trusted: a
  // token revoked or expired since last time should land its holder on the
  // sign-in screen with a reason, not in an app where every request 401s.
  useEffect(() => {
    if (state !== 'checking') return;
    let cancelled = false;
    checkTeamSession(window.location.origin)
      .then((fresh) => {
        if (cancelled) return;
        // Re-saved so a tier changed since sign-in (re-invited with another
        // --tier) is what the app sees.
        saveTeamSession(fresh);
        setState('signed-in');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        clearTeamSession();
        setNotice(describeError(err));
        setState('signed-out');
      });
    return () => {
      cancelled = true;
    };
  }, [state]);

  // Both gate screens sit in GateFrame with no window chrome: a team-local page is always
  // a browser tab, never the desktop window.
  if (state === 'checking') {
    return (
      <GateFrame>
        <div className={styles.checking}>
          <Spinner size="lg" label="Checking your session" />
        </div>
      </GateFrame>
    );
  }
  if (state === 'signed-out') {
    return (
      <GateFrame errorLabel="the sign-in">
        <SignInView
          baseUrl={window.location.origin}
          notice={notice}
          onSignedIn={() => window.location.reload()}
        />
      </GateFrame>
    );
  }
  return <>{children}</>;
}
