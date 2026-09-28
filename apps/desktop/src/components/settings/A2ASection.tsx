import type {
  A2AClientSummary,
  A2AListenerSettings,
  A2AListenerStatus,
  ApiClient,
} from '@dispatch/client';
import { ApiError } from '@dispatch/client';
import type { UseQueryResult } from '@tanstack/react-query';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Check, Plus, RotateCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import type { ListenerForm } from '../../lib/a2a';
import {
  A2A_DEFAULT_PORT,
  a2aQueryKey,
  cardSummary,
  formFromStatus,
  formToSettings,
  isLoopbackHost,
  listenerFieldOf,
  listenerStatusLine,
  openTasksByClient,
  parseRecipients,
  withHost,
} from '../../lib/a2a';
import { isInsufficientTier } from '../../lib/daemonAuth';
import { formatShortDate } from '../../lib/taskDates';
import { SettingsSwitch } from './fields';
import { SettingsGroup, SettingsHint, SettingsRow } from './SettingsGroup';
import { CopyButton } from './TeamSection';
import { IconButton } from '@/ui/ai/icon-button';
import { Pill } from '@/ui/ai/pill';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/ui/alert-dialog';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';

interface A2ASectionProps {
  data: DispatchProjectData;
}

type Api = ApiClient | null;

const OPERATOR_HINT =
  'Changing the listener needs the operator tier. Ask the person running Dispatch for this project.';
const DECIDE_HINT =
  'This needs Can approve access. Ask the person running Dispatch for this project.';

const HOSTS: { value: string; label: string }[] = [
  { value: '127.0.0.1', label: 'This machine' },
  { value: '0.0.0.0', label: 'Every network interface' },
];

// The two hosts on offer, plus a stored one set elsewhere (`localhost`, `::`).
function hostChoices(stored: string): { value: string; label: string }[] {
  return HOSTS.some((h) => h.value === stored)
    ? HOSTS
    : [...HOSTS, { value: stored, label: stored }];
}

// The fields with a row of their own to show a refusal under.
const FIELD_ROWS: ReadonlySet<keyof ListenerForm> = new Set([
  'port',
  'publicUrl',
  'certPath',
  'keyPath',
]);

const CLIENT_STATUS: Record<A2AClientSummary['status'], string> = {
  pending: 'Waiting for approval',
  approved: 'Approved',
  revoked: 'Revoked',
};

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : 'The request failed.';
}

// One A2A query, keyed under the shared `dispatch-a2a` prefix.
function useA2AQuery<T>(
  client: Api,
  what: 'listener' | 'card' | 'clients' | 'tasks',
  fetch: (api: ApiClient) => Promise<T>,
  enabled = true
): UseQueryResult<T> {
  return useQuery({
    queryKey: a2aQueryKey(client?.baseUrl, what),
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return fetch(client);
    },
    enabled: client !== null && enabled,
  });
}

// A field's refusal, shown under the field it names.
function FieldProblem({ message }: { message: string | null }) {
  if (message === null) return null;
  return (
    <p role="alert" className="text-state-failed text-[12px]">
      {message}
    </p>
  );
}

/** Settings → A2A: the opt-in listener, its card, clients and open tasks.
 *  The listener needs operator; approving, rotating and revoking need decide. */
export function A2ASection({ data }: A2ASectionProps) {
  const { client, myTier } = data;
  const canDecide = myTier === 'decide' || myTier === 'operator';
  return (
    <>
      <ListenerGroup client={client} canOperate={myTier === 'operator'} />
      <CardGroup client={client} />
      <ClientsGroup client={client} canDecide={canDecide} />
      <TasksGroup client={client} canDecide={canDecide} />
    </>
  );
}

function ListenerGroup({
  client,
  canOperate,
}: {
  client: Api;
  canOperate: boolean;
}) {
  const queryClient = useQueryClient();
  const status = useA2AQuery(client, 'listener', (api) => api.a2aListener());
  // The form as edited; null follows the daemon's settings.
  const [draft, setDraft] = useState<ListenerForm | null>(null);
  const [problem, setProblem] = useState<{
    field: keyof ListenerForm | null;
    message: string;
  } | null>(null);
  const [pending, setPending] = useState(false);

  const group = (children: ReactNode) => (
    <SettingsGroup
      title="Listener"
      requires="none"
      hint="Closed until you turn it on. It answers on a port of its own, never the one this app uses."
      keywords="a2a agent port host tls tunnel public url"
    >
      {children}
    </SettingsGroup>
  );
  if (status.isError) {
    return group(
      <SettingsRow
        title="Couldn't load the listener"
        subtitle={errorText(status.error)}
      />
    );
  }
  if (status.data === undefined) {
    return group(<SettingsRow title="Loading the listener…" />);
  }
  const current: A2AListenerStatus = status.data;
  const form = draft ?? formFromStatus(current);
  const locked = !canOperate;
  const update = (patch: Partial<ListenerForm>) => {
    setDraft({ ...form, ...patch });
    setProblem(null);
  };
  const problemAt = (field: keyof ListenerForm) =>
    problem !== null && problem.field === field ? problem.message : null;

  // Turning it off keeps the stored settings; anything else is checked here
  // first, so a refusal names its field before anything is sent.
  async function save() {
    if (client === null || pending) return;
    let settings: A2AListenerSettings | null = null;
    if (form.enabled) {
      const built = formToSettings(form);
      if ('field' in built) {
        setProblem({ field: built.field, message: built.error });
        return;
      }
      settings = built.settings;
    }
    setPending(true);
    setProblem(null);
    try {
      const next =
        settings === null
          ? await client.disableA2AListener()
          : await client.setA2AListener(settings);
      queryClient.setQueryData(a2aQueryKey(client.baseUrl, 'listener'), next);
      setDraft(null);
      // The card advertises the listener's URL.
      void queryClient.invalidateQueries({
        queryKey: a2aQueryKey(client.baseUrl, 'card'),
      });
    } catch (err) {
      setProblem({
        field:
          err instanceof ApiError && err.field !== undefined
            ? listenerFieldOf(err.field)
            : null,
        message: isInsufficientTier(err) ? OPERATOR_HINT : errorText(err),
      });
    } finally {
      setPending(false);
    }
  }

  const loopback = isLoopbackHost(form.host);
  return group(
    <>
      {locked && (
        <SettingsRow
          title="Operator only"
          subtitle={OPERATOR_HINT}
          locked={OPERATOR_HINT}
        />
      )}
      <SettingsRow
        title="A2A listener"
        htmlFor="a2a-listener"
        subtitle={listenerStatusLine(current)}
        control={
          <SettingsSwitch
            id="a2a-listener"
            checked={form.enabled}
            disabled={locked}
            onCheckedChange={(enabled) => update({ enabled })}
          />
        }
      >
        {current.warnings.map((warning) => (
          <SettingsHint key={warning}>config.yml: {warning}</SettingsHint>
        ))}
        {current.legacyClients.map((address) => (
          <SettingsHint key={address}>
            {address} was approved before A2A clients were listed here. Revoke
            it, then add it again below.
          </SettingsHint>
        ))}
      </SettingsRow>
      <SettingsRow
        title="Host"
        htmlFor="a2a-host"
        subtitle="This machine suits a tunnel or reverse proxy, which does TLS. Every network interface needs TLS and a public URL."
        control={
          <Select
            value={form.host}
            disabled={locked}
            onValueChange={(host) => {
              if (host === null) return;
              setDraft(withHost(form, host, current.teamTls));
              setProblem(null);
            }}
          >
            <SelectTrigger
              id="a2a-host"
              aria-label="Host"
              className="w-[200px]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {hostChoices(current.settings.host).map((h) => (
                <SelectItem key={h.value} value={h.value}>
                  {h.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <SettingsRow
        title="Port"
        htmlFor="a2a-port"
        subtitle="The card's URL needs one that stays put."
        control={
          <Input
            id="a2a-port"
            value={form.port}
            inputMode="numeric"
            placeholder={String(A2A_DEFAULT_PORT)}
            disabled={locked}
            className="w-24 text-right tabular-nums"
            onChange={(e) => update({ port: e.target.value })}
          />
        }
      >
        <FieldProblem message={problemAt('port')} />
      </SettingsRow>
      <SettingsRow
        title="Public URL"
        htmlFor="a2a-public-url"
        subtitle="What the card tells clients to call. Empty on this machine; behind a tunnel, the tunnel's https URL."
        stacked
      >
        <Input
          id="a2a-public-url"
          value={form.publicUrl}
          placeholder="https://agent.example.com"
          spellCheck={false}
          disabled={locked}
          className="font-mono"
          onChange={(e) => update({ publicUrl: e.target.value })}
        />
        <FieldProblem message={problemAt('publicUrl')} />
      </SettingsRow>
      <SettingsRow
        title="TLS certificate"
        htmlFor="a2a-tls-cert"
        subtitle="A PEM file. Needed on every network interface."
        stacked
      >
        <Input
          id="a2a-tls-cert"
          value={form.certPath}
          placeholder="/path/to/cert.pem"
          spellCheck={false}
          disabled={locked}
          className="font-mono"
          onChange={(e) => update({ certPath: e.target.value })}
        />
        <FieldProblem message={problemAt('certPath')} />
      </SettingsRow>
      <SettingsRow title="TLS key" htmlFor="a2a-tls-key" stacked>
        <Input
          id="a2a-tls-key"
          value={form.keyPath}
          placeholder="/path/to/key.pem"
          spellCheck={false}
          disabled={locked}
          className="font-mono"
          onChange={(e) => update({ keyPath: e.target.value })}
        />
        <FieldProblem message={problemAt('keyPath')} />
      </SettingsRow>
      {loopback && (
        <SettingsRow
          title="Trust X-Forwarded-For"
          htmlFor="a2a-forwarded-for"
          subtitle="Behind a tunnel: count per-address limits by the address the tunnel forwards."
          control={
            <SettingsSwitch
              id="a2a-forwarded-for"
              checked={form.trustForwardedFor}
              disabled={locked}
              onCheckedChange={(trustForwardedFor) =>
                update({ trustForwardedFor })
              }
            />
          }
        />
      )}
      <SettingsRow
        title="Apply"
        subtitle="Saved on this machine only, never in config.yml."
        control={
          <Button disabled={locked || pending} onClick={() => void save()}>
            {pending ? 'Saving…' : 'Save listener'}
          </Button>
        }
      >
        <FieldProblem
          message={
            problem !== null &&
            (problem.field === null || !FIELD_ROWS.has(problem.field))
              ? problem.message
              : null
          }
        />
      </SettingsRow>
    </>
  );
}

function CardGroup({ client }: { client: Api }) {
  const card = useA2AQuery(client, 'card', (api) => api.a2aCard());
  const listener = useA2AQuery(client, 'listener', (api) => api.a2aListener());
  const summary = card.data === undefined ? null : cardSummary(card.data);
  // A closed listener's card carries a placeholder URL nothing answers on.
  const endpoint =
    listener.data?.listening === true ? (summary?.url ?? null) : null;
  return (
    <SettingsGroup
      title="Card"
      requires="none"
      hint="What a client reads before it asks anything. Its name, description and skills come from a2a: in config.yml."
      keywords="agent card skills"
    >
      {card.isError ? (
        <SettingsRow
          title="Couldn't load the card"
          subtitle={errorText(card.error)}
        />
      ) : summary === null ? (
        <SettingsRow title="Loading the card…" />
      ) : (
        <>
          <SettingsRow
            title={summary.name === '' ? 'Unnamed' : summary.name}
            subtitle={summary.description}
          />
          <SettingsRow
            title="Skills"
            control={
              <span className="flex flex-wrap justify-end gap-1">
                {summary.skills.map((skill) => (
                  <Pill key={skill}>{skill}</Pill>
                ))}
              </span>
            }
          />
          {endpoint !== null && (
            <SettingsRow
              title="Endpoint"
              subtitle={<span className="font-mono">{endpoint}</span>}
            />
          )}
        </>
      )}
    </SettingsGroup>
  );
}

function ClientsGroup({
  client,
  canDecide,
}: {
  client: Api;
  canDecide: boolean;
}) {
  const queryClient = useQueryClient();
  const clients = useA2AQuery(client, 'clients', (api) => api.a2aClients());
  const [name, setName] = useState('');
  const [recipients, setRecipients] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The one token on screen: a new client's, or a rotated one's.
  const [issued, setIssued] = useState<{
    address: string;
    token: string;
  } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<A2AClientSummary | null>(null);

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ['dispatch-a2a'] });

  async function add() {
    const trimmed = name.trim();
    if (client === null || trimmed === '' || pending) return;
    const to = parseRecipients(recipients);
    setPending(true);
    setError(null);
    try {
      const added = await client.addA2AClient({
        name: trimmed,
        ...(to.length === 0 ? {} : { to }),
        // Below decide the daemon refuses approve; the client then waits.
        ...(canDecide ? { approve: true } : {}),
      });
      setIssued({ address: added.address, token: added.token });
      setName('');
      setRecipients('');
      await refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setPending(false);
    }
  }

  // One row action; a rotation's token replaces whatever token was shown.
  async function act(
    row: A2AClientSummary,
    change: (api: ApiClient) => Promise<object>
  ) {
    if (client === null || busy !== null) return;
    setBusy(row.address);
    setError(null);
    try {
      const result = await change(client);
      if ('token' in result && typeof result.token === 'string') {
        setIssued({ address: row.address, token: result.token });
      } else if (issued?.address === row.address) {
        setIssued(null);
      }
      await refresh();
    } catch (err) {
      setError(isInsufficientTier(err) ? DECIDE_HINT : errorText(err));
    } finally {
      setBusy(null);
    }
  }

  const rows = clients.data?.clients ?? [];
  return (
    <>
      <SettingsGroup
        title="Clients"
        requires="none"
        hint="Each client gets its own token. It can ask you, and anyone else you name, questions."
        keywords="a2a token agent add rotate revoke approve"
      >
        {clients.isError && (
          <SettingsRow
            title="Couldn't load clients"
            subtitle={errorText(clients.error)}
          />
        )}
        {clients.data !== undefined && rows.length === 0 && (
          <SettingsRow
            title="No clients yet"
            subtitle="Add one below, then hand its token to whoever runs it."
          />
        )}
        {rows.map((row) => (
          <SettingsRow
            key={row.address}
            title={<span className="font-mono">{row.address}</span>}
            subtitle={[
              CLIENT_STATUS[row.status],
              row.recipients.length === 0
                ? null
                : `Also reaches ${row.recipients.join(', ')}`,
            ]
              .filter((part) => part !== null)
              .join(' · ')}
            control={
              row.status === 'revoked' ? undefined : (
                <span className="flex items-center gap-0.5">
                  {row.status === 'pending' && (
                    <IconButton
                      label={`Approve ${row.address}`}
                      disabled={!canDecide || busy !== null}
                      onClick={() =>
                        void act(row, (api) => api.approveAgent(row.address))
                      }
                    >
                      <Check aria-hidden />
                    </IconButton>
                  )}
                  <IconButton
                    label={`Rotate ${row.address}`}
                    disabled={!canDecide || busy !== null}
                    onClick={() =>
                      void act(row, (api) => api.rotateA2AClient(row.address))
                    }
                  >
                    <RotateCw aria-hidden />
                  </IconButton>
                  <IconButton
                    label={`Revoke ${row.address}`}
                    disabled={!canDecide || busy !== null}
                    onClick={() => setConfirming(row)}
                  >
                    <Ban aria-hidden />
                  </IconButton>
                </span>
              )
            }
          />
        ))}
        {!canDecide && rows.length > 0 && (
          <SettingsRow
            title="Approving, rotating and revoking"
            subtitle={DECIDE_HINT}
            locked={DECIDE_HINT}
          />
        )}
        {issued !== null && (
          <SettingsRow
            title={`Token for ${issued.address}`}
            subtitle="Shown once. Hand it to the client's operator."
            stacked
          >
            <div className="flex items-center gap-2">
              <code className="bg-surface-quaternary rounded-control min-w-0 flex-1 truncate px-2 py-1 font-mono text-[12px]">
                {issued.token}
              </code>
              <CopyButton value={issued.token} label="token" />
            </div>
          </SettingsRow>
        )}
        <SettingsRow title="Client name" htmlFor="a2a-client-name" stacked>
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <Input
              id="a2a-client-name"
              value={name}
              placeholder="acme-planner"
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setName(e.target.value)}
            />
            <label
              htmlFor="a2a-client-recipients"
              className="text-foreground text-[13px] font-medium"
            >
              May also address
            </label>
            <Input
              id="a2a-client-recipients"
              value={recipients}
              placeholder="alice, bob"
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setRecipients(e.target.value)}
            />
            <SettingsHint>
              {canDecide
                ? 'It can ask you from the start.'
                : 'It waits until someone who can approve lets it in.'}
            </SettingsHint>
            <div>
              <Button type="submit" disabled={name.trim() === '' || pending}>
                <Plus />
                Add client
              </Button>
            </div>
          </form>
          <FieldProblem message={error} />
        </SettingsRow>
      </SettingsGroup>

      {confirming !== null && (
        <AlertDialog open onOpenChange={(open) => !open && setConfirming(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Revoke {confirming.address}?</AlertDialogTitle>
              <AlertDialogDescription>
                Its token stops working at once, and its unanswered questions
                are closed. To come back it needs a new client and token.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel variant="ghost">Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => {
                  const row = confirming;
                  setConfirming(null);
                  void act(row, (api) => api.revokeAgent(row.address));
                }}
              >
                Revoke
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  );
}

// A task state as a person reads it: INPUT_REQUIRED becomes "Input required".
function stateLabel(state: string): string {
  const words = state.toLowerCase().replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function TasksGroup({
  client,
  canDecide,
}: {
  client: Api;
  canDecide: boolean;
}) {
  const tasks = useA2AQuery(
    client,
    'tasks',
    (api) => api.a2aTasks(),
    canDecide
  );
  const open = openTasksByClient(tasks.data?.tasks ?? []);
  return (
    <SettingsGroup
      title="Open tasks"
      requires="none"
      hint="Questions and handoffs from clients that have not finished yet. Decline an unanswered question from its thread."
      keywords="a2a tasks questions"
    >
      {!canDecide ? (
        <SettingsRow
          title="Listing tasks"
          subtitle={DECIDE_HINT}
          locked={DECIDE_HINT}
        />
      ) : tasks.isError ? (
        <SettingsRow
          title="Couldn't load tasks"
          subtitle={errorText(tasks.error)}
        />
      ) : tasks.data === undefined ? (
        <SettingsRow title="Loading tasks…" />
      ) : open.size === 0 ? (
        <SettingsRow title="Nothing open" />
      ) : (
        [...open].map(([address, list]) => (
          <SettingsRow
            key={address}
            title={<span className="font-mono">{address}</span>}
          >
            <ul className="font-book text-muted-foreground flex flex-col gap-0.5 text-[12px]">
              {list.map((task) => (
                <li key={task.id}>
                  {task.skill === 'ask' ? 'Question' : 'Handoff'} {task.id} ·{' '}
                  {stateLabel(task.state)} · {formatShortDate(task.statusAt)}
                </li>
              ))}
            </ul>
          </SettingsRow>
        ))
      )}
    </SettingsGroup>
  );
}
