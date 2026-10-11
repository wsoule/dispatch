import type { AuthTier } from '@dispatch/client';
import { KeyRound } from 'lucide-react';
import { useState } from 'react';

import type { TeamSession } from '../lib/teamLocal';
import { saveTeamSession } from '../lib/teamLocal';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Spinner } from '@/ui/spinner';

interface SignInViewProps {
  /** The daemon's origin — the page's own, in team-local mode. */
  baseUrl: string;
  /** Called once the daemon has set the session cookie. The app reloads on
   *  it: every query and socket is built around one credential, and starting
   *  clean is simpler than re-keying them all in place. */
  onSignedIn: (session: TeamSession) => void;
  /** Why the last credential stopped working, when one did. */
  notice?: string | null;
}

/** Why the daemon turned a credential away, as the sentence to show: its own
 *  message for an expired token (which names the date and who to ask), and a
 *  plain one for everything else a 401 can mean. */
async function refusal(res: Response): Promise<Error> {
  const body = (await res.json().catch(() => ({}))) as {
    code?: string;
    error?: string;
  };
  if (body.code === 'auth_token_expired' && body.error !== undefined) {
    return new Error(body.error);
  }
  return new Error(
    'That token is not recognised. It may have been revoked or replaced — ask for a new one.'
  );
}

/**
 * Trades a pasted token for a session. The daemon checks it and, if it is
 * good, answers with who it speaks for and an HttpOnly cookie — so a typo
 * fails here with a sentence rather than as every query going 401 at once,
 * and the token is never kept anywhere page script can read it.
 */
export async function signInWithToken(
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<TeamSession> {
  const res = await fetchImpl(`${baseUrl}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (res.status === 401) throw await refusal(res);
  if (!res.ok) {
    throw new Error(
      `The daemon answered ${res.status}. Try again in a moment.`
    );
  }
  const who = (await res.json()) as { handle: string; tier: AuthTier };
  return { handle: who.handle, tier: who.tier };
}

/**
 * Who the session cookie this browser holds speaks for right now — checked on
 * every load, so a token revoked or expired since last time lands its holder
 * on the sign-in screen with the reason.
 */
export async function checkTeamSession(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<TeamSession> {
  const res = await fetchImpl(`${baseUrl}/api/whoami`);
  if (res.status === 401) throw await refusal(res);
  if (!res.ok) {
    throw new Error(
      `The daemon answered ${res.status}. Try again in a moment.`
    );
  }
  const who = (await res.json()) as { handle: string; tier: AuthTier };
  return { handle: who.handle, tier: who.tier };
}

/**
 * The team-local front door: a teammate on someone else's daemon signs in with
 * the token `dispatch team invite` gave them. Only ever shown on a page the
 * daemon served in team-local mode — the desktop app and a solo browser tab
 * never see it.
 */
export function SignInView({ baseUrl, onSignedIn, notice }: SignInViewProps) {
  const [token, setToken] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const trimmed = token.trim();
    if (trimmed === '' || pending) return;
    setPending(true);
    setError(null);
    try {
      const session = await signInWithToken(baseUrl, trimmed);
      saveTeamSession(session);
      onSignedIn(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex h-full min-h-screen flex-col items-center justify-center px-6">
      <form
        className="flex w-full max-w-md flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="flex flex-col gap-1">
          <h1 className="flex items-center gap-2 text-lg font-medium">
            <KeyRound aria-hidden className="size-5" />
            Sign in to this project
          </h1>
          <p className="text-text-secondary text-sm">
            Paste the token you were sent. Whoever runs this daemon makes one
            with <code className="font-mono text-xs">dispatch team invite</code>
            .
          </p>
        </div>
        {notice !== undefined && notice !== null && (
          <p className="text-sm text-(--state-waiting-fg)">{notice}</p>
        )}
        <Input
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          aria-label="Team token"
          placeholder="Team token"
          className="font-mono"
        />
        {error !== null && (
          <p className="text-sm text-(--state-error-fg)" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" disabled={token.trim() === '' || pending}>
          {pending && <Spinner className="size-4" />}
          {pending ? 'Checking…' : 'Sign in'}
        </Button>
      </form>
    </div>
  );
}
