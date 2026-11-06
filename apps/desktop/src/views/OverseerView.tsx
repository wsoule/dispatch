import type { MergeQueueEntry, RunMeta } from '@dispatch/client';
import {
  Button,
  ChipButton,
  cx,
  Notice,
  SlideOver,
  Tooltip,
} from '@dispatch/ui';
import { LockIcon, Minus, PowerOff } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';

import { DockedConversation } from '../components/chat/DockedConversation';
import { OverseerChat } from '../components/chat/OverseerChat';
import {
  ColumnInSheet,
  InflowColumn,
  OutflowColumn,
  outflowCount,
  type OutflowExtras,
  SheetTitle,
} from '../components/overseer/FlowColumns';
import { TakeOverDaemon } from '../components/settings/TakeOverDaemon';
import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import type { OverseerSession } from '../hooks/useOverseerSession';
import { revokedLocksComposer } from '../lib/agentPresence';
import { docked, restored, useOverseerDock } from '../lib/overseerDock';
import type { OverseerDoor } from '../lib/overseerThread';
import styles from './OverseerView.module.css';

export interface OverseerViewProps {
  data: DispatchProjectData;
  overseer: OverseerSession;
  /** The project, which keys its own set-aside conversations. */
  projectPath: string | null;
  /** Asks waiting on you; the stream shows a door to them, never a copy. */
  asks: number;
  /** The Needs you block, beside the stream on a wide window. */
  needsBlock?: ReactNode;
  /** What a side column opened, shown in the middle in place of the conversation. */
  focus?: OverseerFocus | null;
  onFocus?: (focus: OverseerFocus | null) => void;
  renderFocus?: (focus: OverseerFocus, onClose: () => void) => ReactNode;
  revoked: boolean;
  onShowAsks: () => void;
  onOpenConnectedAgents: () => void;
  /** "For you" posts: beside the stream on a wide window, above the composer otherwise. */
  posts?: ReactNode;
  /** How many posts `posts` holds, for the Coming in count. */
  postsCount?: number;
  /** Live and recent runs, and the merge queue's entries, for the Going out column. */
  runs?: readonly RunMeta[];
  merges?: readonly MergeQueueEntry[];
  /** AI task drafts, under the asks and posts in Coming in. */
  drafts?: ReactNode;
  /** How many drafts are drafting, ready or waiting on answers, for the Coming in count. */
  draftsCount?: number;
  /** The notification history, at the foot of Coming in. */
  notifications?: ReactNode;
  /** Live milestones, Merge all ready and today's spend, for Going out. */
  outflow?: OutflowExtras;

  /** Opens one of the agent's "Show in tasks" doors. */
  onOpenDoor: (door: OverseerDoor) => void;
  /** An empty project's first-run prompt, shown in place of a fresh conversation. */
  firstRun?: ReactNode;
}

const isSlash = (text: string) => text.trimStart().startsWith('/');

const ICON = { size: 14, strokeWidth: 1.8, 'aria-hidden': true } as const;

/** Why the composer is locked: the daemon refuses the Overseer to the agent token this window fell back to. */
export const OVERSEER_ATTACHED_EXPLANATION =
  "Something else started Dispatch for this project, so this window only holds the agents' token, and the Overseer only talks to you.";

/** What a side column can open in the middle: a task (maybe on its conversation) or someone's talk. */
export type OverseerFocus =
  | { kind: 'task'; taskId: string; conversation?: boolean }
  | { kind: 'address'; address: string };

/**
 * The Overseer page: the open conversation in the middle; on a wide window
 * the asks and any set-aside conversations sit in a column on the right.
 */
export function OverseerView({
  data,
  overseer,
  projectPath,
  asks,
  needsBlock,
  revoked,
  onShowAsks,
  onOpenConnectedAgents,
  posts,
  postsCount = 0,
  runs = [],
  merges = [],
  drafts,
  draftsCount = 0,
  notifications,
  outflow: outflow_,
  focus = null,
  onFocus = () => {},
  renderFocus,
  onOpenDoor,
  firstRun,
}: OverseerViewProps) {
  // The board and runs the chat's task cards read; a row opens its task in the middle.
  const work = useMemo(
    () => ({
      tasks: data.tasks,
      runs,
      onOpenTask: (taskId: string) => onFocus({ kind: 'task', taskId }),
    }),
    [data.tasks, runs, onFocus]
  );

  // Whatever a side column opened takes the middle; Esc hands it back to the
  // talk. In the app the global keyboard claims Escape first and closes the
  // focus itself (App's escape command, appNav's escapeLeavesNav); this
  // listener serves a host without that keyboard, and skips a handled Escape.
  useEffect(() => {
    if (focus === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) onFocus(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focus, onFocus]);
  // Which column a narrow view has open in a slide-over. The column stays
  // named while the panel slides out, so its title and body do not flip.
  const [sheet, setSheet] = useState<'in' | 'out' | null>(null);
  const [sheetColumn, setSheetColumn] = useState<'in' | 'out'>('in');
  const openSheet = (column: 'in' | 'out') => {
    setSheetColumn(column);
    setSheet(column);
  };
  // Whether the sheet was open when a focus opened, read by the effect below
  // (which runs on focus changes only).
  const sheetOpen = useRef(false);
  useEffect(() => {
    sheetOpen.current = sheet !== null;
  }, [sheet]);
  // A focus just opened: the opener (a door in the now hidden talk, a row in
  // the sheet) can no longer hold focus, so it moves into the focus rather
  // than falling to <body>. A pick in the sheet moves it at once, before the
  // sheet closes; either way it is checked again a frame later (after the
  // sheet hands focus back to its door, which the focus has just hidden),
  // and focus still somewhere on screen (a row in a wide column) stays put.
  const focusRef = useRef<HTMLDivElement>(null);
  const hadFocus = useRef(false);
  useEffect(() => {
    const opened = focus !== null && !hadFocus.current;
    hadFocus.current = focus !== null;
    if (!opened) return undefined;
    if (sheetOpen.current) focusRef.current?.focus({ preventScroll: true });
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement;
      const lost =
        !(active instanceof HTMLElement) ||
        active === document.body ||
        active.closest('[hidden], [inert]') !== null ||
        active.offsetParent === null;
      if (lost) focusRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focus]);
  // A focus opened from either column (a run, a notification, a post, a
  // draft) closes the sheet, so it never covers what was just opened.
  useEffect(() => {
    if (focus !== null) setSheet(null);
  }, [focus]);
  const focused =
    focus !== null && renderFocus !== undefined
      ? renderFocus(focus, () => onFocus(null))
      : null;
  // Attached to a daemon this app didn't start: the Overseer refuses the agent token we hold.
  const attached = data.attachedWithoutAppToken;
  const { dock: stored, setDock } = useOverseerDock(projectPath);
  const open = overseer.conversationId;
  const dock = useMemo(
    () => stored.filter((id) => id !== open),
    [stored, open]
  );
  // The conversation Jev just set aside for a new topic, for "Put it back".
  const [setAside, setSetAside] = useState<{
    id: string;
    title: string;
  } | null>(null);

  const minimize = () => {
    if (open === null) return;
    setDock((d) => docked(d, open));
    setSetAside(null);
    overseer.reset();
  };
  const restore = (id: string) => {
    setDock((d) => restored(d, id, open));
    setSetAside(null);
    overseer.open(id);
  };
  const close = (id: string) => setDock((d) => d.filter((x) => x !== id));

  // A message Jev reads as a new subject opens its own conversation and sets
  // the current one aside; anything else, or no reading, stays put.
  const client = data.client;
  const routed: OverseerSession = {
    ...overseer,
    submit: async (text) => {
      if (open !== null && client !== null && !isSlash(text)) {
        const reading = await client
          .judgeOverseerTopic(open, text)
          .catch(() => null);
        if (reading?.newTopic === true) {
          setDock((d) => docked(d, open));
          setSetAside({ id: open, title: overseer.record?.prompt ?? open });
          await overseer.submitNew(text);
          return;
        }
      }
      await overseer.submit(text);
    },
  };

  if (data.portLoading || data.portError || client === null) {
    return (
      <div className={styles.unavailable}>
        <DaemonUnavailable
          starting={data.portLoading}
          errorDetail={data.portErrorDetail}
          onRetry={data.retryEnsureDispatchd}
        />
      </div>
    );
  }

  // Only a fresh conversation gives way to the first-run prompt.
  const showFirstRun = firstRun !== undefined && open === null;
  const showAsksAside = asks > 0 && needsBlock !== undefined && !revoked;
  // On a wide view the asks themselves are in Coming in, so the door goes.
  const door =
    revoked || asks === 0 ? null : (
      <span className={cx(styles.door, showAsksAside && styles.narrowOnly)}>
        <ChipButton
          tone="warning"
          onClick={onShowAsks}
          data-testid="overseer-asks-door"
        >
          {asks} {asks === 1 ? 'ask waits' : 'asks wait'} on you · Show in tasks
          →
        </ChipButton>
      </span>
    );
  const dockCards = (compact: boolean) =>
    dock.map((id) => (
      <DockedConversation
        key={id}
        client={client}
        port={data.port}
        conversationId={id}
        compact={compact}
        onRestore={() => restore(id)}
        onClose={() => close(id)}
      />
    ));

  const inflowCount = (showAsksAside ? asks : 0) + postsCount + draftsCount;
  const inflow = (
    <InflowColumn count={inflowCount}>
      {showAsksAside && needsBlock}
      {posts}
      {drafts}
      {notifications}
    </InflowColumn>
  );
  const outflow = (
    <OutflowColumn
      runs={runs}
      merges={merges}
      setAside={dockCards(false)}
      onOpenTask={(taskId) => onFocus({ kind: 'task', taskId })}
      {...outflow_}
    />
  );
  // Below the columns' width (the modules' container query) they are hidden;
  // these open the same columns in a slide-over on the right.
  const columnDoors = (
    <div className={styles.columnDoors} data-testid="overseer-column-doors">
      <ChipButton onClick={() => openSheet('in')}>
        {inflowCount > 0 ? `Coming in · ${inflowCount}` : 'Coming in'}
      </ChipButton>
      <ChipButton onClick={() => openSheet('out')}>Going out</ChipButton>
    </div>
  );

  return (
    <div data-testid="overseer-view" className={styles.root}>
      {/* Wide views read left to right: what comes to you, the talk, what leaves. */}
      {inflow}
      {focused !== null && (
        <div
          ref={focusRef}
          tabIndex={-1}
          data-testid="overseer-focus"
          className={styles.focus}
        >
          {focused}
        </div>
      )}
      {/* Hidden, not unmounted, while something else holds the middle: the draft
          survives, and ⌘F's offsetParent check skips it. Before the first message
          the composer sits at the bottom, as it will after. */}
      <div
        className={cx(
          styles.talk,
          open === null && !showFirstRun && styles.talkAtEnd
        )}
        hidden={focused !== null}
      >
        {open !== null && (
          <div className={styles.talkBar}>
            <Tooltip
              side="bottom"
              content="Set this conversation aside and start another"
            >
              <Button
                variant="quiet"
                size="sm"
                icon={<Minus {...ICON} />}
                onClick={minimize}
                data-testid="overseer-minimize"
              >
                Set aside
              </Button>
            </Tooltip>
          </div>
        )}
        {setAside !== null && (
          <div role="status" className={styles.setAside}>
            <span className={styles.setAsideText}>
              New topic, so a new conversation · “{setAside.title}” is set aside
            </span>
            <Button
              variant="quiet"
              size="sm"
              onClick={() => restore(setAside.id)}
            >
              Put it back
            </Button>
          </div>
        )}
        {revoked && (
          // Off is inactive: the grey of the status table.
          <Notice
            tone="muted"
            data-testid="overseer-off"
            action={
              <Button
                variant="secondary"
                size="sm"
                onClick={onOpenConnectedAgents}
              >
                Approve it again in Settings › Connected agents
              </Button>
            }
          >
            <span className={styles.noticeLine}>
              <PowerOff {...ICON} />
              <span className={styles.noticeTitle}>The agent is off.</span>
            </span>
          </Notice>
        )}
        {attached && (
          // A locked composer is a missing input: the amber of the status table.
          <Notice tone="warning" data-testid="overseer-attached">
            <div className={styles.noticeStack}>
              <span className={styles.noticeLine}>
                <LockIcon {...ICON} />
                <span className={styles.noticeTitle}>
                  This window can't talk to the Overseer.
                </span>
              </span>
              <span>{OVERSEER_ATTACHED_EXPLANATION}</span>
              {data.takeover !== null && (
                <TakeOverDaemon
                  takeover={data.takeover}
                  onRestart={data.handleRestartDaemon}
                />
              )}
            </div>
          </Notice>
        )}
        {showFirstRun ? (
          <div data-testid="overseer-first-run" className={styles.firstRun}>
            {firstRun}
          </div>
        ) : (
          <OverseerChat
            overseer={routed}
            placeholder="say something"
            aboveComposer={
              <>
                <div className={styles.narrowOnly}>{posts}</div>
                {dock.length > 0 && (
                  <div className={cx(styles.dockChips, styles.narrowOnly)}>
                    {dockCards(true)}
                  </div>
                )}
                {door}
                {columnDoors}
              </>
            }
            disabled={
              revokedLocksComposer({ revoked, conversationId: open }) ||
              attached
            }
            onOpenDoor={onOpenDoor}
            work={work}
          />
        )}
      </div>
      {outflow}
      {/* Modal, as the legacy sheet was (a press on the scrim closes it), on
          the right for both columns (Q8), as wide as a column. Its title names
          the column and its count; the column inside draws no head of its own.
          Its Escape is the layer stack's, taken before any page listener, so
          Escape peels the panel first, then the focus. */}
      <SlideOver
        open={sheet !== null}
        onClose={() => setSheet(null)}
        modal
        size="narrow"
        data-testid="overseer-column-sheet"
        title={
          <SheetTitle
            column={sheetColumn}
            count={
              sheetColumn === 'out'
                ? outflowCount({
                    runs,
                    merges,
                    sessions: outflow_?.sessions,
                    setAside: dock.length,
                  })
                : inflowCount
            }
          />
        }
      >
        <ColumnInSheet>
          {sheetColumn === 'out' ? outflow : inflow}
        </ColumnInSheet>
      </SlideOver>
    </div>
  );
}
