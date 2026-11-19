import {
  liveTextStore,
  type OverseerLive,
  overseerLiveKey,
  type OverseerRecordView,
  useLiveText,
} from '@dispatch/client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  actionReply,
  committedSegments,
  gateForCard,
  type OverseerCardRef,
  toolCallReply,
} from './overseer';
import { useRemote } from './remote';

// One Overseer conversation through the tunnel: the daemon's current one
// when the tab opens, or a new one once the person starts it. The record is
// refetched on `overseer.changed`; a running turn's text streams in through
// `overseer.delta` frames into the client's live text store, which repairs a
// missed frame from the record's `live` snapshot.

// One daemon per phone, so the live text store needs no port to tell
// daemons apart.
const PORT = undefined;

export interface OverseerView {
  record: OverseerRecordView | undefined;
  live: OverseerLive | null;
  /** False until the first read has answered. */
  loaded: boolean;
  error: string | null;
  /** Which card is being answered, so its buttons lock. */
  deciding: string | null;
  /** Sends a line: opens a conversation first when there is none. */
  send(text: string): Promise<void>;
  stop(): Promise<void>;
  /** Leaves the current conversation; the next line opens a new one. */
  startOver(): void;
  decide(card: OverseerCardRef, yes: boolean): Promise<void>;
  refresh(): Promise<void>;
}

export function useOverseer(): OverseerView {
  const { client, status, subscribe } = useRemote();
  const [record, setRecord] = useState<OverseerRecordView | undefined>();
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<string | null>(null);
  // null: follow the daemon's current conversation; '' : a fresh one.
  const [pinned, setPinned] = useState<string | null>(null);
  // A conversation belongs to one Mac: switching Macs (a new client) goes
  // back to following that Mac's current conversation.
  useEffect(() => {
    setPinned(null);
    setRecord(undefined);
  }, [client]);
  const idRef = useRef<string | null>(null);
  idRef.current = record?.id ?? null;

  const take = useCallback((next: OverseerRecordView | null) => {
    setRecord(next ?? undefined);
    if (next !== null) {
      liveTextStore.mergeSnapshot(
        PORT,
        overseerLiveKey(next.id),
        next.live,
        () => void refreshRef.current()
      );
    }
  }, []);

  const refresh = useCallback(async () => {
    if (client === null) return;
    try {
      if (pinned === '') take(null);
      else if (pinned !== null) take(await client.getOverseer(pinned));
      else take((await client.currentOverseer()).conversation);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoaded(true);
    }
  }, [client, pinned, take]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  const ready = status.kind === 'ready';
  useEffect(() => {
    if (ready) void refresh();
  }, [ready, refresh]);

  useEffect(
    () =>
      subscribe((event) => {
        if (event.type === 'overseer.changed') {
          if (event.conversationId === idRef.current) void refreshRef.current();
        } else if (event.type === 'overseer.delta') {
          if (event.conversationId !== idRef.current) return;
          liveTextStore.applyDelta(
            PORT,
            overseerLiveKey(event.conversationId),
            {
              turnId: event.turnId,
              seq: event.seq,
              segmentId: event.segmentId,
              text: event.text,
              ...(event.abandoned === true ? { abandoned: true } : {}),
            },
            () => void refreshRef.current()
          );
        }
      }),
    [subscribe]
  );

  const committed = useMemo(() => committedSegments(record), [record]);
  const live = useLiveText(
    PORT,
    record === undefined ? null : overseerLiveKey(record.id),
    record?.state === 'running',
    committed
  );

  const send = useCallback(
    async (text: string) => {
      if (client === null) throw new Error('Not connected');
      if (record === undefined) {
        const started = await client.startOverseer(text);
        setPinned(started.id);
        take(started);
      } else {
        take(await client.sendOverseerMessage(record.id, text));
      }
    },
    [client, record, take]
  );

  const stop = useCallback(async () => {
    if (client === null || record === undefined) return;
    take(await client.stopOverseer(record.id));
  }, [client, record, take]);

  const startOver = useCallback(() => {
    setPinned('');
    setRecord(undefined);
  }, []);

  const decide = useCallback(
    async (card: OverseerCardRef, yes: boolean) => {
      if (client === null || record === undefined) return;
      const key = card.kind === 'action' ? card.actionId : card.requestId;
      setDeciding(key);
      try {
        const gate = gateForCard(
          (await client.openDecisions()).items,
          record.id,
          card
        );
        if (gate === null)
          throw new Error('This is no longer waiting for you.');
        await client.replyToMessage(
          gate.id,
          card.kind === 'action' ? actionReply(yes) : toolCallReply(yes)
        );
        await refresh();
      } finally {
        setDeciding(null);
      }
    },
    [client, record, refresh]
  );

  return {
    record,
    live,
    loaded,
    error,
    deciding,
    send,
    stop,
    startOver,
    decide,
    refresh,
  };
}
