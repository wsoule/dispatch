import { type ApiClient, ApiError, type WardenRecord } from '@dispatch/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Dispatch, SetStateAction } from 'react';
import { useCallback, useEffect, useState } from 'react';

import { isFakeWardenDevToolEnabled } from '../lib/devTools';

/**
 * Every warden record key for one daemon. useDispatchProject invalidates this
 * prefix — rather than a single record's key — when the daemon's `hello`
 * greeting arrives, which the server sends on every websocket open and so on
 * every reconnect. A reconnect usually means dispatchd restarted, which drops
 * every in-memory warden record at once, and that handler has no conversation
 * id to name: the session lives in this hook, not in it. Prefix invalidation
 * is the same idiom useDataChangedEvents applies to `['board']` and
 * `['session-detail']`.
 */
export function wardenKeyPrefix(port: number | undefined) {
  return ['dispatch-warden', port] as const;
}

/** The one warden record query key, exported so useDispatchProject's WS
 * handler can invalidate it on `warden.changed` — the same wiring
 * `plan.changed` uses for `['dispatch-plan', port, planId]`. Built from the
 * prefix above so the `hello` invalidation cannot drift out of matching it. */
export function wardenKey(
  port: number | undefined,
  conversationId: string | null
) {
  return [...wardenKeyPrefix(port), conversationId] as const;
}

export interface WardenSession {
  /** The open conversation, or `null` before one is started (the composer state). */
  conversationId: string | null;
  /**
   * The live record for `conversationId` — `undefined` while it loads, when no
   * conversation is open, and when the fetch 404/410s (the conversation is
   * gone). Consumers can trust it: whatever is readable here is a conversation
   * dispatchd still has.
   */
  record: WardenRecord | undefined;
  /** Why `record` is missing or stale when the fetch itself failed, not just pending. */
  recordError: string | null;
  /**
   * Sends `text` — opening the conversation when none is open yet, posting a
   * follow-up on it when one is. One entry point rather than two because the
   * composer that calls it is one control: `conversationId` alone decides
   * which composer is on screen, so it alone decides which call to make.
   *
   * Owns the whole submit cycle — clearing the draft up front, putting it back
   * when the call fails, raising `sending`, recording `sendError` — because
   * every one of those outlives the composer that triggered it. Never rejects:
   * the outcome is readable on `sending` and `sendError`.
   */
  submit: (text: string) => Promise<void>;
  /**
   * A submit is in flight. Session-held for the same reason `draft` is: the
   * rail unmounts the chat's whole panel on a tab flip, and a component-local
   * flag would come back `false` on remount, briefly re-enabling Send against
   * a turn dispatchd would 409.
   */
  sending: boolean;
  /**
   * Why the last submit failed, or `null`. Cleared when the next one starts
   * and by `reset`. Session-held because the failure usually arrives *after*
   * the user has flipped to Runs to watch the turn — the path this rail
   * encourages — by which point a component-local `setState` is a no-op on an
   * unmounted tree and the failure is reported to nobody.
   */
  sendError: string | null;
  /** Decides one queued mutating action: approving runs the real effect before
   * resolving, denying never runs it. Allowed mid-turn — the server accepts a
   * decision while the assistant is still answering. */
  confirmAction: (actionId: string, approve: boolean) => Promise<WardenRecord>;
  /**
   * Which action `confirmAction` is currently deciding, or `null`. Lives on the
   * session for the same reason `draft` does: the surfaces that render a
   * confirm card are unmounted by ordinary navigation (the rail's tab toggle
   * drops the inactive panel, so does its collapse chevron, and the Warden
   * page replaces the rail entirely). Approving runs the real mutation
   * server-side before the call resolves, so that window is seconds wide — long
   * enough to flip a tab in. A component-local flag would come back `null` on
   * remount, re-enabling every card with no spinner while the effect is still
   * running, and a second click would then 404 against an action the server
   * already claimed.
   */
  decidingActionId: string | null;
  /** Drops back to the "start a conversation" state. Nothing is deleted server-side. */
  reset: () => void;
  /**
   * What the human has typed into the composer but not sent yet. It lives on
   * the session rather than inside WardenChat because every surface that
   * renders that composer is unmounted by something ordinary: the rail's tab
   * toggle, the rail's collapse chevron, and navigating to the Warden page
   * (App mounts the rail only on project views). The session outlives all
   * three, so the draft does too.
   */
  draft: string;
  /**
   * React's own setter, updater form included: a sender that clears the draft
   * before its await has to put the text back if the call fails, but only when
   * the human has not already typed something else — which it can only decide
   * against the current value, not the one its closure captured.
   */
  setDraft: Dispatch<SetStateAction<string>>;
}

/**
 * Owns the active warden conversation: which one is open, its live record, and
 * the three mutations that advance it. A sibling of `useDispatchProject` (which
 * owns the WS connection and invalidates this hook's query on `warden.changed`)
 * rather than another field on it — the warden is one surface's data, and the
 * god-hook is already 2400 lines.
 *
 * Every mutation writes its returned record straight into the query cache: the
 * server responds with the full post-mutation record, so the transcript updates
 * the moment the call resolves rather than waiting a round-trip for the
 * `warden.changed` refetch. Each write is followed by an invalidation of the
 * same key: a turn can settle — and broadcast `warden.changed` — while the
 * mutation's own response is still in flight, in which case that event either
 * found no mounted query to invalidate (start) or its refetch result is about
 * to be overwritten by the staler mutation response (sendMessage). Marking the
 * key stale right after writing lets a refetch reconcile whatever was missed;
 * with a real LLM backend the window is milliseconds wide, but the scripted
 * fake backend settles inside it every time.
 */
export function useWardenSession(
  client: ApiClient | null,
  port: number | undefined,
  projectPath: string | null
): WardenSession {
  const queryClient = useQueryClient();
  const [conversationId, setConversationId] = useState<string | null>(null);

  const [draft, setDraft] = useState('');

  const [decidingActionId, setDecidingActionId] = useState<string | null>(null);

  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // A conversation opened against one project's dispatchd must not survive a
  // project switch — the stale id would 404 against the new daemon (the same
  // I5 rule useDispatchProject applies to planId). The draft goes with it: a
  // half-typed question about project A has no business in project B's
  // composer.
  useEffect(() => {
    setConversationId(null);
    setDraft('');
    setDecidingActionId(null);
    setSendError(null);
  }, [projectPath]);

  const { data: record, error } = useQuery({
    queryKey: wardenKey(port, conversationId),
    queryFn: () => {
      if (client === null || conversationId === null) {
        throw new Error('no warden conversation open');
      }
      return client.getWarden(conversationId);
    },
    enabled: client !== null && conversationId !== null,
    // A stale id mid project-switch should surface its 404, not retry against
    // a daemon that will never have this conversation.
    retry: false,
  });

  const start = useCallback(
    async (prompt: string) => {
      if (client === null) throw new Error('dispatchd client not ready');
      // The dev/e2e escape hatch (see devTools.ts): an opted-in session opens
      // conversations against the daemon's scripted 'fake' backend instead of
      // the real Claude one. Checked per start, not per hook mount, so
      // flipping the flag applies to the next conversation without a reload.
      const rec = await client.startWarden(
        prompt,
        isFakeWardenDevToolEnabled() ? { backend: 'fake' } : {}
      );
      queryClient.setQueryData(wardenKey(port, rec.id), rec);
      setConversationId(rec.id);
      // See the hook comment: the turn may have already settled while this
      // response was in flight, and that broadcast found no query to
      // invalidate. Stale-marking here makes the query's mount refetch pick
      // the settled record up.
      await queryClient.invalidateQueries({
        queryKey: wardenKey(port, rec.id),
      });
      return rec;
    },
    [client, port, queryClient]
  );

  const sendMessage = useCallback(
    async (text: string) => {
      if (client === null || conversationId === null) {
        throw new Error('no warden conversation open');
      }
      const rec = await client.sendWardenMessage(conversationId, text);
      queryClient.setQueryData(wardenKey(port, conversationId), rec);
      // Reconciles a turn that settled mid-flight — without this, the stale
      // `running` record written above would overwrite the settled one the
      // broadcast's refetch already fetched, and nothing would refetch again.
      await queryClient.invalidateQueries({
        queryKey: wardenKey(port, conversationId),
      });
      return rec;
    },
    [client, conversationId, port, queryClient]
  );

  /**
   * The one thing the composer calls. `start` and `sendMessage` above are the
   * raw HTTP mutations; this is the operation a human performs, and it keeps
   * the three pieces of state that operation owns — the draft, the in-flight
   * flag, the failure — together on the session, where they outlive the panel
   * the human typed into.
   *
   * The draft is cleared before the await rather than after: both mutations
   * end in `invalidateQueries`, which waits on a real refetch once the record
   * query has an observer, so clearing afterwards lands a whole round trip
   * late and eats anything typed in the meantime. On failure the text goes
   * back — but only if the composer is still empty, since whatever the human
   * has started typing since is theirs to keep.
   */
  const submit = useCallback(
    async (text: string) => {
      setSending(true);
      setSendError(null);
      setDraft('');
      try {
        if (conversationId === null) {
          await start(text);
        } else {
          await sendMessage(text);
        }
      } catch (err) {
        setSendError(err instanceof Error ? err.message : String(err));
        setDraft((current) => (current === '' ? text : current));
      } finally {
        setSending(false);
      }
    },
    [conversationId, sendMessage, start]
  );

  const confirmAction = useCallback(
    async (actionId: string, approve: boolean) => {
      if (client === null || conversationId === null) {
        throw new Error('no warden conversation open');
      }
      // Held for the whole call, including the reconciling refetch below, so
      // every card stays locked and the deciding one keeps its spinner even if
      // the chat unmounts and remounts underneath it.
      setDecidingActionId(actionId);
      try {
        const rec = await client.confirmWardenAction(
          conversationId,
          actionId,
          approve
        );
        queryClient.setQueryData(wardenKey(port, conversationId), rec);
        // Confirming is allowed mid-turn, so the same in-flight-settle race as
        // sendMessage applies here.
        await queryClient.invalidateQueries({
          queryKey: wardenKey(port, conversationId),
        });
        return rec;
      } finally {
        setDecidingActionId(null);
      }
    },
    [client, conversationId, port, queryClient]
  );

  const reset = useCallback(() => {
    setConversationId(null);
    setDraft('');
    // A failure banner from the conversation being discarded has nothing to
    // say about the empty composer that replaces it.
    setSendError(null);
  }, []);

  // react-query keeps the last good `data` through a *background* refetch
  // failure, which is right for a hiccup and wrong for a conversation the
  // daemon no longer has (records are in-memory, so a restart 404s every id
  // and the cached pendingActions become ghosts nobody can decide). The HTTP
  // status is the only thing that tells the two apart, so the veto happens
  // once here rather than as a guard on every surface that reads the record.
  const recordGone =
    error instanceof ApiError && (error.status === 404 || error.status === 410);

  return {
    conversationId,
    record: recordGone ? undefined : record,
    recordError: error instanceof Error ? error.message : null,
    submit,
    sending,
    sendError,
    confirmAction,
    decidingActionId,
    reset,
    draft,
    setDraft,
  };
}
