import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { DecideAvailability } from '../lib/daemonAuth';
import { availabilityKey } from '../lib/daemonAuth';
import type { KnownAddresses } from '../lib/threads';
import type {
  ParkedCall,
  RefAction,
  ThreadLookups,
} from '../lib/threadSources';
import {
  knownAddresses,
  lookupsKey,
  threadLookups,
} from '../lib/threadSources';
import type { DispatchProjectData } from './useDispatchProject';
import { useA2APeers, useAgentRoster, useChannels } from './useThreads';

export interface ThreadPaneProjectProps {
  lookups: ThreadLookups;
  availability: DecideAvailability;
  known: KnownAddresses;
  onRestartDaemon: () => Promise<void>;
  onOpen: (action: RefAction) => void;
  loadApprovalInput: (call: ParkedCall) => Promise<unknown>;
}

/** What a thread's rows and composer take from the project rather than the
 *  thread, stable while App re-renders on events that change none of it. */
export function useThreadPaneProps(
  data: DispatchProjectData,
  onOpenRef: (action: RefAction) => void
): ThreadPaneProjectProps {
  const { client, port, me, messageAccess: access } = data;
  const agents = useAgentRoster(client, port);
  const channels = useChannels(client, port, access.canMessage);
  const peers = useA2APeers(client, access.canMessage);
  const lookups = useKeyed(lookupsKey(data.tasks, data.runs, agents), () =>
    threadLookups(data.tasks, data.runs, agents)
  );
  const availability = useKeyed(
    availabilityKey(data.scopeDecide),
    () => data.scopeDecide
  );
  const known = useMemo(
    () =>
      knownAddresses({
        tasks: data.tasks,
        channels,
        agents,
        presence: data.presence,
        me,
        peers,
      }),
    [data.tasks, channels, agents, data.presence, me, peers]
  );
  // App rebuilds its handlers on every event; refs keep these callbacks stable for memoised rows.
  const latest = useRef(data);
  useEffect(() => {
    latest.current = data;
  }, [data]);
  const onRestartDaemon = useCallback(
    () => latest.current.handleRestartDaemon(),
    []
  );
  const openRef = useRef(onOpenRef);
  useEffect(() => {
    openRef.current = onOpenRef;
  }, [onOpenRef]);
  const onOpen = useCallback(
    (action: RefAction) => openRef.current(action),
    []
  );
  const loadApprovalInput = useCallback(
    (call: ParkedCall) =>
      'runId' in call
        ? latest.current.fetchApprovalInput(call.runId, call.requestId)
        : latest.current.fetchOverseerApprovalInput(
            call.conversation,
            call.requestId
          ),
    []
  );
  return {
    lookups,
    availability,
    known,
    onRestartDaemon,
    onOpen,
    loadApprovalInput,
  };
}

// What `build` makes, kept as the same object until `key` changes, so memoised
// rows skip the run and board events that change nothing they show.
function useKeyed<T>(key: string, build: () => T): T {
  const [held, setHeld] = useState(() => ({ key, value: build() }));
  if (held.key === key) return held.value;
  const next = { key, value: build() };
  setHeld(next);
  return next.value;
}
