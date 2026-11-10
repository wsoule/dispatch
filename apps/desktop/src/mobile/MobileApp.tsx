import type { Message, RunMeta } from '@dispatch/client';
import {
  Button,
  Chip,
  EmptyState,
  ListItem,
  Panel,
  SectionHeader,
  TextArea,
  TextField,
} from '@dispatch/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellIcon, BellOffIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { PairedPhone } from './mobileApi';
import {
  answer,
  fetchDecisions,
  fetchMe,
  fetchRuns,
  forgetPairing,
  loadPairing,
  MobileApiError,
  pair,
  pairCodeFromHash,
  runsForPhone,
  runStateLabel,
  savePairing,
} from './mobileApi';
import styles from './MobileApp.module.css';
import { disablePush, enablePush, pushSupport } from './push';

// The Dispatch phone app: pair once, then one screen with what is waiting on
// you (answer it in place) and your runs. See the Doc `mobile-app-spec`.

// Polled while the page is visible; pushes cover the time it is closed.
const POLL_MS = 5_000;

/** A sensible default name for this device in the daemon's device list. */
function guessDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  return 'Phone';
}

export function MobileApp() {
  const [pairing, setPairing] = useState<PairedPhone | null>(() =>
    loadPairing()
  );
  if (pairing === null)
    return (
      <PairScreen
        onPaired={(p) => {
          savePairing(p);
          setPairing(p);
        }}
      />
    );
  return (
    <Home
      pairing={pairing}
      onUnpaired={() => {
        forgetPairing();
        setPairing(null);
      }}
    />
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className={styles.shell}>{children}</main>;
}

function PairScreen({ onPaired }: { onPaired: (p: PairedPhone) => void }) {
  const [code, setCode] = useState(() => pairCodeFromHash(location.hash) ?? '');
  const [name, setName] = useState(guessDeviceName);
  const pairing = useMutation({
    mutationFn: () => pair(code, name),
    onSuccess: (p) => {
      // The code is spent; keep it out of the address bar and history.
      history.replaceState(null, '', '/m/');
      onPaired(p);
    },
  });
  return (
    <Shell>
      <h1 className={styles.pairHeading}>Pair this phone with Dispatch</h1>
      <p className={styles.muted}>
        On your computer, run <code>dispatch pair --tier decide</code> and enter
        the code it shows.
      </p>
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          pairing.mutate();
        }}
      >
        <TextField
          aria-label="Pairing code"
          placeholder="XXXX-XXXX"
          autoCapitalize="characters"
          autoComplete="one-time-code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
        <TextField
          aria-label="Name for this phone"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <Button
          type="submit"
          size="lg"
          disabled={code.trim() === '' || pairing.isPending}
        >
          {pairing.isPending ? 'Pairing…' : 'Pair'}
        </Button>
        {pairing.error !== null && (
          <p role="alert" className={styles.error}>
            {pairing.error.message}
          </p>
        )}
      </form>
    </Shell>
  );
}

function Home({
  pairing,
  onUnpaired,
}: {
  pairing: PairedPhone;
  onUnpaired: () => void;
}) {
  const { token } = pairing;
  const decisions = useQuery({
    queryKey: ['mobile', 'decisions'],
    queryFn: () => fetchDecisions(token),
    refetchInterval: POLL_MS,
  });
  const runs = useQuery({
    queryKey: ['mobile', 'runs'],
    queryFn: () => fetchRuns(token),
    refetchInterval: POLL_MS,
  });

  // A 401 means the daemon no longer knows this phone (it was unpaired):
  // back to the pairing screen rather than a wall of errors.
  const unpaired = [decisions.error, runs.error].some(
    (e) => e instanceof MobileApiError && e.status === 401
  );
  useEffect(() => {
    if (unpaired) onUnpaired();
  }, [unpaired, onUnpaired]);

  // A tapped notification opens `#decision=<id>`; bring that card into view.
  const [focusId, setFocusId] = useState(() => decisionFromHash(location.hash));
  useEffect(() => {
    const onHash = () => setFocusId(decisionFromHash(location.hash));
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; url?: string } | null;
      if (data?.type === 'open' && typeof data.url === 'string') {
        history.replaceState(null, '', data.url);
        onHash();
      }
    };
    addEventListener('hashchange', onHash);
    navigator.serviceWorker?.addEventListener('message', onMessage);
    return () => {
      removeEventListener('hashchange', onHash);
      navigator.serviceWorker?.removeEventListener('message', onMessage);
    };
  }, []);

  const items = decisions.data ?? [];
  const { live, recent } = runsForPhone(runs.data ?? []);

  return (
    <Shell>
      <header className={styles.header}>
        <h1 className={styles.heading}>Dispatch</h1>
        <NotificationsButton token={token} />
      </header>

      <section aria-label="Needs you" className={styles.stack}>
        <SectionHeader name="Needs you" count={items.length} />
        {decisions.isPending ? null : items.length === 0 ? (
          <EmptyState label="Nothing is waiting on you">
            Questions and approvals from your agents show up here.
          </EmptyState>
        ) : (
          items.map((m) => (
            <DecisionCard
              key={m.id}
              token={token}
              message={m}
              focused={m.id === focusId}
            />
          ))
        )}
      </section>

      <section aria-label="Runs" className={styles.stack}>
        <SectionHeader name="Runs" count={live.length + recent.length} />
        <div role="list">
          {[...live, ...recent].map((run) => (
            <RunRow key={run.id} run={run} />
          ))}
        </div>
        {!runs.isPending && live.length + recent.length === 0 && (
          <p className={styles.muted}>No runs in the last day.</p>
        )}
      </section>

      <footer className={styles.footer}>
        <Button variant="quiet" size="sm" onClick={onUnpaired}>
          Forget this phone
        </Button>
      </footer>
    </Shell>
  );
}

function decisionFromHash(hash: string): string | null {
  const match = /(?:^#|&)decision=([^&]+)/.exec(hash);
  return match === null ? null : decodeURIComponent(match[1]);
}

function RunRow({ run }: { run: RunMeta }) {
  return (
    <ListItem
      role="listitem"
      title={run.taskTitle}
      trailing={<Chip>{runStateLabel(run)}</Chip>}
    />
  );
}

// What an answer choice reads as on a button: `approve` → `Approve`.
function choiceLabel(choice: string): string {
  return choice.charAt(0).toUpperCase() + choice.slice(1);
}

// A short line under the question saying who asks and, for a gate, about what.
function decisionDetail(message: Message): string {
  const data = message.data as { type?: string; tool?: string } | undefined;
  if (data?.type === 'tool-approval' && data.tool !== undefined)
    return `${message.from} wants to run ${data.tool}`;
  return `From ${message.from}`;
}

function DecisionCard({
  token,
  message,
  focused,
}: {
  token: string;
  message: Message;
  focused: boolean;
}) {
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const reply = useMutation({
    mutationFn: (input: { choice?: string; body: string }) =>
      answer(token, message.id, input),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['mobile', 'decisions'] }),
  });
  const choices = message.choices ?? [];
  // A gate is answered only by its choices; a question also takes words.
  const isGate =
    typeof message.data === 'object' &&
    message.data !== null &&
    'type' in message.data;

  return (
    <div
      ref={(el) => {
        if (focused) el?.scrollIntoView({ block: 'center' });
      }}
      className={styles.stack}
    >
      <Panel>
        <div className={styles.stack}>
          <p className={styles.question}>{message.body}</p>
          <p className={styles.muted}>{decisionDetail(message)}</p>
          <div className={styles.choices} role="group" aria-label="Choices">
            {choices.map((c) => (
              <Button
                key={c}
                variant={c === chosen ? 'primary' : 'secondary'}
                size="lg"
                aria-pressed={c === chosen}
                disabled={reply.isPending || reply.isSuccess}
                onClick={() => {
                  setChosen(c);
                  reply.mutate({ choice: c, body: choiceLabel(c) });
                }}
              >
                {choiceLabel(c)}
              </Button>
            ))}
          </div>
        </div>
      </Panel>
      {!isGate && !reply.isSuccess && (
        <form
          className={styles.stack}
          onSubmit={(event) => {
            event.preventDefault();
            reply.mutate({ body: text.trim() });
          }}
        >
          <TextArea
            aria-label="Your answer"
            placeholder="Answer in your own words"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <Button
            type="submit"
            disabled={text.trim() === '' || reply.isPending}
          >
            Send
          </Button>
        </form>
      )}
      {reply.error !== null && (
        <p role="alert" className={styles.error}>
          {reply.error.message}
        </p>
      )}
    </div>
  );
}

function NotificationsButton({ token }: { token: string }) {
  const queryClient = useQueryClient();
  const support = pushSupport();
  const me = useQuery({
    queryKey: ['mobile', 'me'],
    queryFn: () => fetchMe(token),
    enabled: support === 'supported',
  });
  const toggle = useMutation({
    mutationFn: (on: boolean) => (on ? enablePush(token) : disablePush(token)),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ['mobile', 'me'] }),
  });

  if (support === 'needs-install')
    return (
      <p className={`${styles.muted} ${styles.small} ${styles.right}`}>
        Add to Home Screen to get notifications
      </p>
    );
  if (support === 'unsupported') return null;
  const on = me.data?.push === true;
  return (
    <div className={styles.end}>
      <Button
        variant="secondary"
        size="sm"
        disabled={toggle.isPending || me.isPending}
        onClick={() => toggle.mutate(!on)}
      >
        {on ? <BellIcon /> : <BellOffIcon />}
        {on ? 'Notifications on' : 'Turn on notifications'}
      </Button>
      {toggle.error !== null && (
        <p
          role="alert"
          className={`${styles.error} ${styles.small} ${styles.right}`}
        >
          {toggle.error.message}
        </p>
      )}
    </div>
  );
}
