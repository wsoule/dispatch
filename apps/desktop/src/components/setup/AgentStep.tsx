import type { ProviderState, SetupFix } from '@dispatch-foo/core/browser';
import type { ApiClient } from '@dispatch/client';
import {
  Button,
  Chip,
  cx,
  Field,
  RadioGroup,
  type RadioOption,
  TextField,
  type UiTone,
} from '@dispatch/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { SETUP_REPORT_STALE_MS, setupReportKey } from '../../lib/setupState';
import { openUrl } from '../../lib/tauri';
import { RawDetails } from '../gr8r/RawText';
import { CommandTerminal } from './CommandTerminal';
import { errorText } from './errorText';
import styles from './setup.module.css';
import { SetupStepRow } from './SetupStepRow';

interface AgentStepProps {
  client: ApiClient;
  /** The project's daemon port, which scopes the cached setup report. */
  port: number | undefined;
  /** Persists the chosen provider as the project's default agent. */
  onSetDefault: (providerId: string) => Promise<unknown>;
  onContinue: () => void;
  /** Label of the confirm button; Settings uses "Save". */
  continueLabel?: string;
}

type Running = {
  providerId: string;
  fix: Extract<SetupFix, { kind: 'run' }>;
  title: string;
  /** A sign-in, which ends with its terminal; an install runs to its end. */
  signIn: boolean;
};

/** A plain sentence for the screen plus the raw reason for the Details disclosure. */
type Problem = { sentence: string; detail: string };

function problemOf(sentence: string, err: unknown): Problem {
  return { sentence, detail: errorText(err) };
}

function stateLabel(p: ProviderState): string {
  if (!p.installed) return 'Not installed';
  if (!p.works) return "Won't start";
  if (p.usingApiKey) return 'Using an API key';
  if (p.auth === 'signed-in') return 'Signed in';
  if (p.auth === 'signed-out') return 'Signed out';
  return 'Installed';
}

/* The state chip's tone, read from the same facts as its words: ready is green, a
   provider that wants a sign-in is amber, one that will not start is red, and one that
   is not installed (or has nothing to report) is grey. */
function stateTone(p: ProviderState): UiTone {
  if (!p.installed) return 'muted';
  if (!p.works) return 'danger';
  if (p.usingApiKey || p.auth === 'signed-in') return 'success';
  if (p.auth === 'signed-out') return 'warning';
  return 'muted';
}

/** Pick an agent, install it, sign in (or paste a key), and continue. Works for every catalog provider. */
export function AgentStep({
  client,
  port,
  onSetDefault,
  onContinue,
  continueLabel = 'Continue',
}: AgentStepProps) {
  const queryClient = useQueryClient();
  const reportKey = setupReportKey(port);
  const { data } = useQuery({
    queryKey: reportKey,
    queryFn: () => client.fetchSetup(),
    staleTime: SETUP_REPORT_STALE_MS,
  });
  const [chosen, setChosen] = useState<string | null>(null);
  const [running, setRunning] = useState<Running | null>(null);
  const [keyFor, setKeyFor] = useState<string | null>(null);
  const [key, setKey] = useState('');
  const [problem, setProblem] = useState<Problem | null>(null);

  if (data === undefined) {
    return (
      <SetupStepRow
        status="checking"
        title="Your AI agent"
        message="Checking…"
      />
    );
  }

  const step = data.steps.find((s) => s.id === 'agent');
  if (step === undefined) return null;
  const selected = chosen ?? data.defaultProvider;
  const ordered = [...data.providers].sort(
    (a, b) =>
      Number(b.ready) - Number(a.ready) ||
      Number(b.installed) - Number(a.installed)
  );
  const selectedProvider = data.providers.find((p) => p.id === selected);
  // Follows the picked provider; with nothing picked, the overall step decides.
  const canContinue =
    selectedProvider === undefined
      ? step.status === 'ok' || step.status === 'unknown'
      : selectedProvider.installed &&
        selectedProvider.works &&
        (selectedProvider.ready || selectedProvider.auth === 'unknown');

  // The report and the daemon's executor list (Dispatch buttons' default agent)
  // both change after a refresh or a new default.
  function invalidateAgents() {
    return Promise.all([
      queryClient.invalidateQueries({ queryKey: reportKey }),
      queryClient.invalidateQueries({ queryKey: ['dispatch-executors'] }),
    ]);
  }

  // Re-reads the machine after an install or sign-in so the row reflects it.
  async function recheck() {
    try {
      await client.refreshSetup();
      await invalidateAgents();
    } catch (err) {
      setProblem(problemOf("Couldn't re-check your agents.", err));
    }
  }

  function act(p: ProviderState, fix: SetupFix) {
    setChosen(p.id);
    setProblem(null);
    if (fix.kind === 'run') {
      const signIn = fix === p.signIn;
      setRunning({
        providerId: p.id,
        fix,
        title: signIn ? `Sign in to ${p.name}` : fix.label,
        signIn,
      });
    } else if (fix.kind === 'open-url') {
      openUrl(fix.href).catch((err: unknown) =>
        setProblem(problemOf("Couldn't open the download page.", err))
      );
    }
  }

  async function saveKey(p: ProviderState) {
    setProblem(null);
    try {
      const next = await client.saveAgentKey(p.id, key);
      queryClient.setQueryData(reportKey, next);
      setKeyFor(null);
      setKey('');
    } catch (err) {
      setProblem(
        problemOf("Couldn't save that key. Check it and try again.", err)
      );
    }
  }

  async function removeKey(p: ProviderState) {
    setProblem(null);
    try {
      queryClient.setQueryData(
        reportKey,
        await client.saveAgentKey(p.id, null)
      );
    } catch (err) {
      setProblem(problemOf("Couldn't remove that key. Try again.", err));
    }
  }

  // Refreshes first so an agent installed outside this screen (a download page, a
  // terminal) is known before it becomes the default.
  async function proceed() {
    setProblem(null);
    try {
      await client.refreshSetup();
      if (selected !== null) await onSetDefault(selected);
      await invalidateAgents();
      onContinue();
    } catch (err) {
      setProblem(problemOf("Couldn't save your choice. Try again.", err));
    }
  }

  // Opens the key form for one provider with an empty field, so a key typed for another
  // provider is never saved under this one.
  function openKeyForm(p: ProviderState) {
    setKeyFor(p.id);
    setKey('');
  }

  // The API-key controls under a checked card: the key form, the "using a key" line
  // with Replace and Remove, or the offer to use a key instead of the sign-in.
  function keyBlock(p: ProviderState) {
    if (p.apiKeyEnv === undefined || !p.installed) return null;
    if (keyFor === p.id) {
      return (
        <div className={styles.keyForm}>
          <Field label={`${p.name} API key`} className={styles.keyField}>
            <TextField
              type="password"
              autoComplete="off"
              spellCheck={false}
              className={styles.keyInput}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </Field>
          <Button disabled={key.trim() === ''} onClick={() => void saveKey(p)}>
            Save key
          </Button>
        </div>
      );
    }
    if (p.usingApiKey) {
      return (
        <div className={styles.keyLine}>
          <span className={styles.keyNote}>
            Using an API key instead of your {p.name} sign-in.
          </span>
          <Button size="sm" variant="quiet" onClick={() => openKeyForm(p)}>
            Replace key
          </Button>
          <Button size="sm" variant="quiet" onClick={() => void removeKey(p)}>
            Remove key
          </Button>
        </div>
      );
    }
    return (
      <Button
        size="sm"
        variant="quiet"
        className={styles.keyOffer}
        onClick={() => openKeyForm(p)}
      >
        Use an API key instead
      </Button>
    );
  }

  // One provider as a card: its name and blurb pick it; the state chip and the
  // Install / Sign in buttons sit beside it, outside the radio's name; the key controls
  // show under it while it is the checked card. A running install or sign-in terminal is
  // not among them (see the step's body below).
  function providerOption(p: ProviderState): RadioOption {
    const keys = keyBlock(p);
    return {
      value: p.id,
      label: p.name,
      hint: p.blurb,
      'aria-label': `Use ${p.name}`,
      disabled: !p.installed,
      aside: (
        <div className={styles.providerAside}>
          <Chip tone={stateTone(p)}>{stateLabel(p)}</Chip>
          {p.install !== undefined && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => p.install && act(p, p.install)}
            >
              {p.install.label}
            </Button>
          )}
          {p.installed && p.works && !p.ready && p.signIn !== undefined && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => p.signIn && act(p, p.signIn)}
            >
              Sign in
            </Button>
          )}
        </div>
      ),
      children: keys ?? undefined,
    };
  }

  return (
    <SetupStepRow
      status={step.status}
      title="Your AI agent"
      message={step.message}
      action={
        <Button
          variant="primary"
          disabled={!canContinue}
          onClick={() => void proceed()}
        >
          {continueLabel}
        </Button>
      }
      {...(step.detail === undefined ? {} : { detail: step.detail })}
    >
      {problem !== null && (
        <div className={styles.problem}>
          <p
            className={cx(styles.alert, 'toneText')}
            data-tone="danger"
            role="alert"
          >
            {problem.sentence}
          </p>
          <RawDetails text={problem.detail} />
        </div>
      )}
      <RadioGroup
        variant="cards"
        label="Choose your AI agent"
        options={ordered.map(providerOption)}
        value={selected ?? null}
        onChange={setChosen}
      />
      {/* The running install or sign-in sits under the cards, not inside one: a card's
          children show only while it is checked, and picking another card must not
          unmount a terminal whose command is still running (its exit re-checks the
          agents, and a remount would start the command again). */}
      {running !== null && (
        <CommandTerminal
          key={`${running.providerId} ${running.fix.command.join(' ')}`}
          client={client}
          command={running.fix.command}
          title={running.title}
          // A sign-in left behind would wait for input nobody can give, so
          // it ends with its terminal; an install is never stopped midway
          // (a half-done `npm install -g` or `brew install`), so another
          // card's action or Continue lets it finish in the background.
          endOnUnmount={running.signIn}
          onExit={() => {
            setRunning(null);
            void recheck();
          }}
        />
      )}
    </SetupStepRow>
  );
}
