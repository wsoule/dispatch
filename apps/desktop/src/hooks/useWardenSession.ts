import type { ApiClient, WardenRecord } from '@dispatch/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';

import { isFakeWardenDevToolEnabled } from '../lib/devTools';

/** The one warden record query key, exported so useDispatchProject's WS
 * handler can invalidate it on `warden.changed` — the same wiring
 * `plan.changed` uses for `['dispatch-plan', port, planId]`. */
export function wardenKey(
  port: number | undefined,
  conversationId: string | null
) {
  return ['dispatch-warden', port, conversationId] as const;
}

export interface WardenSession {
  /** The open conversation, or `null` before one is started (the composer state). */
  conversationId: string | null;
  /** The live record for `conversationId` — `undefined` while it loads (or when none is open). */
  record: WardenRecord | undefined;
  /** Why `record` is missing when the fetch itself failed, not just pending. */
  recordError: string | null;
  /** Opens a conversation; resolves with the record already `running`. */
  start: (prompt: string) => Promise<WardenRecord>;
  /** Posts a follow-up on the open conversation (202, back to `running`). */
  sendMessage: (text: string) => Promise<WardenRecord>;
  /** Decides one queued mutating action: approving runs the real effect before
   * resolving, denying never runs it. Allowed mid-turn — the server accepts a
   * decision while the assistant is still answering. */
  confirmAction: (actionId: string, approve: boolean) => Promise<WardenRecord>;
  /** Drops back to the "start a conversation" state. Nothing is deleted server-side. */
  reset: () => void;
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

  // A conversation opened against one project's dispatchd must not survive a
  // project switch — the stale id would 404 against the new daemon (the same
  // I5 rule useDispatchProject applies to planId).
  useEffect(() => {
    setConversationId(null);
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

  const confirmAction = useCallback(
    async (actionId: string, approve: boolean) => {
      if (client === null || conversationId === null) {
        throw new Error('no warden conversation open');
      }
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
    },
    [client, conversationId, port, queryClient]
  );

  const reset = useCallback(() => setConversationId(null), []);

  return {
    conversationId,
    record,
    recordError: error instanceof Error ? error.message : null,
    start,
    sendMessage,
    confirmAction,
    reset,
  };
}
