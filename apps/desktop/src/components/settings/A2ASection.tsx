import type {
  A2AClientSummary,
  A2AListenerSettings,
  A2AListenerStatus,
  A2APeerInput,
  A2APeerSummary,
  ApiClient,
} from '@dispatch/client';
import { ApiError } from '@dispatch/client';
import type { UseQueryResult } from '@tanstack/react-query';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Ban,
  Check,
  KeyRound,
  Link2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useRef, useState } from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import type { ListenerForm } from '../../lib/a2a';
import {
  a2aQueryKey,
  cardSummary,
  formFromStatus,
  formToSettings,
  isLoopbackHost,
  listenerFieldOf,
  listenerStatusLine,
  openTasksByClient,
  originConflict,
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
  what:
    | 'listener'
    | 'card'
    | 'clients'
    | 'tasks'
    | 'peers'
    | 'keys'
    | 'pairings'
    | 'links',
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
      <PeersGroup
        client={client}
        canDecide={canDecide}
        canOperate={myTier === 'operator'}
      />
      <PairingGroup client={client} canDecide={canDecide} />
      <LinksGroup client={client} canDecide={canDecide} />
      <KeysGroup client={client} canOperate={myTier === 'operator'} />
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
  const [standalonePending, setStandalonePending] = useState(false);
  const [standaloneProblem, setStandaloneProblem] = useState<string | null>(
    null
  );

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

  // Applies at once, apart from Save: the switch the port routes check.
  async function setStandalone(enabled: boolean) {
    if (client === null || standalonePending) return;
    setStandalonePending(true);
    setStandaloneProblem(null);
    try {
      const { standalone } = await client.setA2AStandalone(enabled);
      queryClient.setQueryData(a2aQueryKey(client.baseUrl, 'listener'), {
        ...current,
        settings: { ...current.settings, standalone },
      });
      if (draft !== null) setDraft({ ...draft, standalone });
    } catch (err) {
      setStandaloneProblem(
        isInsufficientTier(err) ? OPERATOR_HINT : errorText(err)
      );
    } finally {
      setStandalonePending(false);
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
      <SettingsRow
        title="Standalone hosts"
        htmlFor="a2a-standalone"
        subtitle="Lets hosts added with dispatch a2a hosts add serve this project from another machine. Applies at once."
        control={
          <SettingsSwitch
            id="a2a-standalone"
            checked={current.settings.standalone}
            disabled={locked || standalonePending}
            onCheckedChange={(enabled) => void setStandalone(enabled)}
          />
        }
      >
        <FieldProblem message={standaloneProblem} />
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

// How a peer is reached: paired and signed, a plain bearer, or a link.
const PEER_AUTH: Record<NonNullable<A2APeerSummary['auth']>, string> = {
  signature: 'Signed',
  bearer: 'Not verified',
  link: 'Link',
};

const PEER_STATUS: Record<A2APeerSummary['status'], string> = {
  active: 'Active',
  disabled: 'Disabled',
  'auth-failed': 'Credential refused',
};

// Reads a password field's value and empties it, so a credential lives only
// in the DOM until the request is built and never in React state.
function takeSecret(ref: { current: HTMLInputElement | null }): string {
  const field = ref.current;
  if (field === null) return '';
  const value = field.value.trim();
  field.value = '';
  return value;
}

// The add form's text fields; the credential is read from its input instead.
interface PeerDraft {
  alias: string;
  cardUrl: string;
  apiKeyHeader: string;
  allowHttp: boolean;
  allowOrigin: boolean;
}

const EMPTY_PEER: PeerDraft = {
  alias: '',
  cardUrl: '',
  apiKeyHeader: '',
  allowHttp: false,
  allowOrigin: false,
};

/** Outbound peers: who runs here may message as `a2a:<alias>`. Everyone sees
 *  the list; adding and changing peers needs decide, and http or another
 *  origin needs the operator. Card text and URLs render as plain text. */
function PeersGroup({
  client,
  canDecide,
  canOperate,
}: {
  client: Api;
  canDecide: boolean;
  canOperate: boolean;
}) {
  const queryClient = useQueryClient();
  const peers = useA2AQuery(client, 'peers', (api) => api.a2aPeers());
  const [draft, setDraft] = useState<PeerDraft>(EMPTY_PEER);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<{
    field: string | null;
    message: string;
  } | null>(null);
  const [conflict, setConflict] = useState<{
    cardOrigin: string;
    interfaceOrigin: string;
  } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<A2APeerSummary | null>(null);
  const [upgrading, setUpgrading] = useState<string | null>(null);
  const [theirFingerprint, setTheirFingerprint] = useState('');
  const [upgradeNote, setUpgradeNote] = useState<string | null>(null);
  const secret = useRef<HTMLInputElement | null>(null);
  const newSecrets = useRef(new Map<string, HTMLInputElement>());

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ['dispatch-a2a'] });

  async function add() {
    // Taken first, so the field is empty whether or not the request goes out.
    const token = takeSecret(secret);
    const alias = draft.alias.trim();
    const cardUrl = draft.cardUrl.trim();
    if (client === null || pending || alias === '' || cardUrl === '') return;
    const header = draft.apiKeyHeader.trim();
    const input: A2APeerInput = {
      alias,
      cardUrl,
      ...(token === '' ? {} : { token }),
      ...(header === '' ? {} : { apiKeyHeader: header }),
      ...(canOperate && draft.allowHttp ? { allowHttp: true } : {}),
      ...(canOperate && draft.allowOrigin ? { allowOrigin: true } : {}),
    };
    setPending(true);
    setProblem(null);
    setConflict(null);
    try {
      await client.addA2APeer(input);
      setDraft(EMPTY_PEER);
      await refresh();
    } catch (err) {
      const message = errorText(err);
      const field =
        err instanceof ApiError
          ? (err.field ?? null)
          : typeof (err as { field?: unknown }).field === 'string'
            ? (err as { field: string }).field
            : null;
      const origins = originConflict({
        ...(field === null ? {} : { field }),
        message,
      });
      if (origins !== null) setConflict(origins);
      else
        setProblem({
          field,
          message: isInsufficientTier(err) ? DECIDE_HINT : message,
        });
    } finally {
      setPending(false);
    }
  }

  // One row action; its failure shows under the list.
  async function act(
    alias: string,
    change: (api: ApiClient) => Promise<unknown>
  ) {
    if (client === null || busy !== null) return;
    setBusy(alias);
    setRowError(null);
    try {
      await change(client);
      await refresh();
    } catch (err) {
      setRowError(isInsufficientTier(err) ? DECIDE_HINT : errorText(err));
    } finally {
      setBusy(null);
    }
  }

  function enableWithSecret(alias: string) {
    const field = newSecrets.current.get(alias) ?? null;
    const token = takeSecret({ current: field });
    void act(alias, (api) =>
      api.setA2APeerEnabled(alias, true, token === '' ? undefined : token)
    );
  }

  const rows = peers.data?.peers ?? [];
  const problemAt = (field: string) =>
    problem !== null && problem.field === field ? problem.message : null;
  const otherProblem =
    problem !== null &&
    !['alias', 'cardUrl', 'token', 'apiKeyHeader'].includes(problem.field ?? '')
      ? problem.message
      : null;
  const update = (patch: Partial<PeerDraft>) => {
    setDraft({ ...draft, ...patch });
    setProblem(null);
  };

  return (
    <>
      <SettingsGroup
        title="Peers"
        requires="none"
        hint="Outside A2A agents runs here may message as a2a:<alias>. Whatever is sent to a peer leaves this machine."
        keywords="a2a peers outbound agent card credential"
      >
        {peers.isError ? (
          <SettingsRow
            title="Couldn't load peers"
            subtitle={errorText(peers.error)}
          />
        ) : peers.data === undefined ? (
          <SettingsRow title="Loading peers…" />
        ) : rows.length === 0 ? (
          <SettingsRow
            title="No peers yet"
            subtitle={
              canDecide
                ? 'Add one below from its agent card URL.'
                : 'Someone who can approve adds peers.'
            }
          />
        ) : (
          rows.map((row) => (
            <SettingsRow
              key={row.alias}
              title={<span className="font-mono">a2a:{row.alias}</span>}
              subtitle={
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">
                    {[
                      PEER_AUTH[row.auth ?? 'bearer'],
                      PEER_STATUS[row.status],
                      row.name,
                    ]
                      .filter((part) => part !== '')
                      .join(' · ')}
                  </span>
                  <span className="truncate font-mono">{row.interfaceUrl}</span>
                  {row.fingerprint != null && (
                    <span className="truncate font-mono">
                      {row.fingerprint}
                    </span>
                  )}
                </span>
              }
              control={
                canDecide ? (
                  <span className="flex items-center gap-0.5">
                    <IconButton
                      label={`Refresh a2a:${row.alias}`}
                      disabled={busy !== null}
                      onClick={() =>
                        void act(row.alias, (api) =>
                          api.refreshA2APeer(row.alias)
                        )
                      }
                    >
                      <RefreshCw aria-hidden />
                    </IconButton>
                    {row.status === 'active' ? (
                      <IconButton
                        label={`Disable a2a:${row.alias}`}
                        disabled={busy !== null}
                        onClick={() =>
                          void act(row.alias, (api) =>
                            api.setA2APeerEnabled(row.alias, false)
                          )
                        }
                      >
                        <Pause aria-hidden />
                      </IconButton>
                    ) : row.status === 'disabled' ? (
                      <IconButton
                        label={`Enable a2a:${row.alias}`}
                        disabled={busy !== null}
                        onClick={() =>
                          void act(row.alias, (api) =>
                            api.setA2APeerEnabled(row.alias, true)
                          )
                        }
                      >
                        <Play aria-hidden />
                      </IconButton>
                    ) : null}
                    {(row.auth ?? 'bearer') === 'bearer' && (
                      <IconButton
                        label={`Upgrade a2a:${row.alias} to signed`}
                        disabled={busy !== null}
                        onClick={() => {
                          setUpgrading(row.alias);
                          setTheirFingerprint('');
                          setUpgradeNote(null);
                        }}
                      >
                        <ShieldCheck aria-hidden />
                      </IconButton>
                    )}
                    <IconButton
                      label={`Remove a2a:${row.alias}`}
                      disabled={busy !== null}
                      onClick={() => setRemoving(row)}
                    >
                      <Trash2 aria-hidden />
                    </IconButton>
                  </span>
                ) : undefined
              }
            >
              {canDecide && upgrading === row.alias && (
                <form
                  className="flex items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const fp = theirFingerprint.trim();
                    if (fp === '') return;
                    void act(row.alias, async (api) => {
                      const started = await api.upgradeA2APeer(row.alias, fp);
                      setUpgrading(null);
                      setUpgradeNote(
                        `a2a:${row.alias} (key ${started.fingerprint}) waits for its owner to approve signed requests.`
                      );
                    });
                  }}
                >
                  <Input
                    aria-label="Their fingerprint"
                    placeholder="As its owner reads it to you"
                    value={theirFingerprint}
                    spellCheck={false}
                    autoComplete="off"
                    className="h-7 min-w-0 flex-1 font-mono text-[12px]"
                    onChange={(e) => setTheirFingerprint(e.target.value)}
                  />
                  <Button type="submit" size="sm" disabled={busy !== null}>
                    Ask to upgrade
                  </Button>
                </form>
              )}
              {canDecide && row.status === 'auth-failed' && (
                <form
                  className="flex items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    enableWithSecret(row.alias);
                  }}
                >
                  <Input
                    type="password"
                    aria-label={`New credential for a2a:${row.alias}`}
                    placeholder="New credential"
                    autoComplete="new-password"
                    spellCheck={false}
                    className="h-7 min-w-0 flex-1 font-mono text-[12px]"
                    ref={(el) => {
                      if (el === null) newSecrets.current.delete(row.alias);
                      else newSecrets.current.set(row.alias, el);
                    }}
                  />
                  <Button type="submit" size="sm" disabled={busy !== null}>
                    Enable a2a:{row.alias}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    aria-label={`Enable a2a:${row.alias} with the same credential`}
                    disabled={busy !== null}
                    onClick={() =>
                      void act(row.alias, (api) =>
                        api.setA2APeerEnabled(row.alias, true, undefined)
                      )
                    }
                  >
                    Same credential
                  </Button>
                </form>
              )}
            </SettingsRow>
          ))
        )}
        <FieldProblem message={rowError} />
        {upgradeNote !== null && <SettingsHint>{upgradeNote}</SettingsHint>}
        {!canDecide && (
          <SettingsRow
            title="Adding and changing peers"
            subtitle={DECIDE_HINT}
            locked={DECIDE_HINT}
          />
        )}
        {canDecide && (
          <SettingsRow title="Add a peer" stacked>
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void add();
              }}
            >
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-2">
                <Input
                  aria-label="Peer alias"
                  value={draft.alias}
                  placeholder="acme"
                  spellCheck={false}
                  autoComplete="off"
                  className="font-mono"
                  onChange={(e) => update({ alias: e.target.value })}
                />
                <Input
                  aria-label="Card URL"
                  value={draft.cardUrl}
                  placeholder="https://agent.example.com/.well-known/agent-card.json"
                  spellCheck={false}
                  autoComplete="off"
                  className="font-mono"
                  onChange={(e) => update({ cardUrl: e.target.value })}
                />
              </div>
              <FieldProblem
                message={problemAt('alias') ?? problemAt('cardUrl')}
              />
              <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-2">
                <Input
                  ref={secret}
                  type="password"
                  aria-label="Peer credential"
                  placeholder="Credential, if its card asks for one"
                  autoComplete="new-password"
                  spellCheck={false}
                  className="font-mono"
                />
                <Input
                  aria-label="API key header"
                  value={draft.apiKeyHeader}
                  placeholder="From the card"
                  spellCheck={false}
                  autoComplete="off"
                  className="font-mono"
                  onChange={(e) => update({ apiKeyHeader: e.target.value })}
                />
              </div>
              <FieldProblem
                message={problemAt('token') ?? problemAt('apiKeyHeader')}
              />
              {conflict !== null && (
                <p role="alert" className="text-state-failed text-[12px]">
                  The card at {conflict.cardOrigin} points its A2A interface at{' '}
                  {conflict.interfaceOrigin}.
                  {canOperate
                    ? ''
                    : ' Only the operator can accept another origin.'}
                </p>
              )}
              {canOperate && (
                <div className="text-muted-foreground flex flex-wrap items-center gap-4 text-[12px]">
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      className="accent-primary size-3.5"
                      checked={draft.allowHttp}
                      onChange={(e) => update({ allowHttp: e.target.checked })}
                    />
                    Allow plain http
                  </label>
                  {conflict !== null && (
                    <label className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        className="accent-primary size-3.5"
                        checked={draft.allowOrigin}
                        onChange={(e) =>
                          update({ allowOrigin: e.target.checked })
                        }
                      />
                      Allow the other origin
                    </label>
                  )}
                </div>
              )}
              <FieldProblem message={otherProblem} />
              <div>
                <Button
                  type="submit"
                  disabled={
                    pending ||
                    draft.alias.trim() === '' ||
                    draft.cardUrl.trim() === ''
                  }
                >
                  <Plus />
                  {pending ? 'Adding…' : 'Add peer'}
                </Button>
              </div>
            </form>
          </SettingsRow>
        )}
      </SettingsGroup>

      {removing !== null && (
        <AlertDialog open onOpenChange={(open) => !open && setRemoving(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove a2a:{removing.alias}?</AlertDialogTitle>
              <AlertDialogDescription>
                Its stored credential is deleted, and questions waiting on it
                are closed. To use it again, add it back.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel variant="ghost">Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => {
                  const alias = removing.alias;
                  setRemoving(null);
                  void act(alias, (api) => api.removeA2APeer(alias));
                }}
              >
                Remove
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  );
}

/** Pairing: one code, typed once on each side, and both agents sign their
 *  requests to each other. The code made here is shown until Done; a code
 *  entered here lives only in its password field (never React state). SAS
 *  and fingerprints render as plain text. */
function PairingGroup({
  client,
  canDecide,
}: {
  client: Api;
  canDecide: boolean;
}) {
  const queryClient = useQueryClient();
  const [alias, setAlias] = useState('');
  const [linkRemote, setLinkRemote] = useState('');
  const [offered, setOffered] = useState<{
    code: string;
    fingerprint: string;
    expiresAt: string;
  } | null>(null);
  const [theirAlias, setTheirAlias] = useState('');
  const [accepted, setAccepted] = useState<{
    alias: string;
    sas: string;
    fingerprint: string;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const code = useRef<HTMLInputElement | null>(null);
  const pairings = useA2AQuery(
    client,
    'pairings',
    (api) => api.a2aPairings(),
    canDecide
  );
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ['dispatch-a2a'] });

  async function offer() {
    const name = alias.trim();
    if (client === null || pending || name === '') return;
    setPending(true);
    setError(null);
    try {
      const remote = linkRemote.trim();
      setOffered(
        await client.createA2APairing(
          remote === '' ? { alias: name } : { alias: name, link: { remote } }
        )
      );
      setAlias('');
      setLinkRemote('');
      await refresh();
    } catch (err) {
      setError(isInsufficientTier(err) ? DECIDE_HINT : errorText(err));
    } finally {
      setPending(false);
    }
  }

  async function accept() {
    // Taken first, so the field is empty whether or not the request goes out.
    const text = takeSecret(code);
    const name = theirAlias.trim();
    if (client === null || pending || text === '' || name === '') return;
    setPending(true);
    setError(null);
    try {
      setAccepted(await client.acceptA2APairing({ code: text, alias: name }));
      setTheirAlias('');
      await refresh();
    } catch (err) {
      setError(isInsufficientTier(err) ? DECIDE_HINT : errorText(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <SettingsGroup
      title="Pairing"
      requires="none"
      hint="Pair with another Dispatch agent by one code. Both sides then sign their requests to each other, and compare the same SAS."
      keywords="a2a pair pairing code sas fingerprint signed"
    >
      {!canDecide ? (
        <SettingsRow
          title="Pairing with other agents"
          subtitle="Someone who can approve pairs this project with other Dispatch agents."
          locked={DECIDE_HINT}
        />
      ) : (
        <>
          {offered !== null && (
            <SettingsRow
              title="Pairing code"
              subtitle={`Shown once, good until ${formatShortDate(offered.expiresAt)}. This agent's fingerprint: ${offered.fingerprint}`}
              stacked
            >
              <div className="flex items-center gap-2">
                <code className="bg-surface-quaternary rounded-control min-w-0 flex-1 px-2 py-1 font-mono text-[12px] break-all">
                  {offered.code}
                </code>
                <CopyButton value={offered.code} label="code" />
                <Button size="sm" onClick={() => setOffered(null)}>
                  Done
                </Button>
              </div>
            </SettingsRow>
          )}
          <SettingsRow title="Pair as" htmlFor="a2a-pair-alias" stacked>
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void offer();
              }}
            >
              <Input
                id="a2a-pair-alias"
                value={alias}
                placeholder="bob"
                spellCheck={false}
                autoComplete="off"
                className="min-w-0 flex-1"
                onChange={(e) => setAlias(e.target.value)}
              />
              <Button type="submit" disabled={alias.trim() === '' || pending}>
                <Link2 />
                Pair with…
              </Button>
            </form>
            <label
              htmlFor="a2a-pair-link"
              className="text-foreground mt-2 text-[13px] font-medium"
            >
              Over a link (git remote)
            </label>
            <Input
              id="a2a-pair-link"
              value={linkRemote}
              placeholder="Optional: a remote you both can push to"
              spellCheck={false}
              autoComplete="off"
              className="font-mono text-[12px]"
              onChange={(e) => setLinkRemote(e.target.value)}
            />
          </SettingsRow>
          <SettingsRow title="Pairing code" htmlFor="a2a-pair-code" stacked>
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void accept();
              }}
            >
              <Input
                id="a2a-pair-code"
                type="password"
                placeholder="dispatch-a2a-pair:…"
                autoComplete="off"
                spellCheck={false}
                className="font-mono text-[12px]"
                ref={code}
              />
              <label
                htmlFor="a2a-pair-their-alias"
                className="text-foreground text-[13px] font-medium"
              >
                Their alias
              </label>
              <Input
                id="a2a-pair-their-alias"
                value={theirAlias}
                placeholder="alice"
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => setTheirAlias(e.target.value)}
              />
              <div>
                <Button type="submit" disabled={pending}>
                  Enter code
                </Button>
              </div>
            </form>
          </SettingsRow>
          {accepted !== null && (
            <SettingsRow
              title={
                <span className="font-mono">
                  Paired with a2a:{accepted.alias}
                </span>
              }
              subtitle={
                <span className="flex min-w-0 flex-col">
                  <span className="font-mono">SAS {accepted.sas}</span>
                  <span className="truncate font-mono">
                    {accepted.fingerprint}
                  </span>
                  <span>Check the other side shows the same SAS.</span>
                </span>
              }
            />
          )}
          {(pairings.data?.pairings ?? []).map((p) => (
            <SettingsRow
              key={p.id}
              title={<span className="font-mono">a2a:{p.alias}</span>}
              subtitle={
                p.state === 'completed' && p.sas !== null ? (
                  <span className="flex min-w-0 flex-col">
                    <span className="font-mono">SAS {p.sas}</span>
                    {p.fingerprint !== null && (
                      <span className="truncate font-mono">
                        {p.fingerprint}
                      </span>
                    )}
                  </span>
                ) : p.state === 'offered' ? (
                  `Waiting for the other side, until ${formatShortDate(p.expiresAt)}`
                ) : (
                  (PAIRING_STATE[p.state] ?? p.state)
                )
              }
              control={
                p.state === 'offered' && p.role === 'offer' ? (
                  <IconButton
                    label={`Cancel the offer for a2a:${p.alias}`}
                    disabled={pending}
                    onClick={() => {
                      if (client === null) return;
                      void client
                        .cancelA2APairing(p.id)
                        .then(refresh, (err: unknown) =>
                          setError(errorText(err))
                        );
                    }}
                  >
                    <Ban aria-hidden />
                  </IconButton>
                ) : undefined
              }
            />
          ))}
          <FieldProblem message={error} />
        </>
      )}
    </SettingsGroup>
  );
}

/** Teammate links (T55): each link's health beside team transport health,
 *  and offers still waiting for the other side's proof on the branch. */
function LinksGroup({
  client,
  canDecide,
}: {
  client: Api;
  canDecide: boolean;
}) {
  const links = useA2AQuery(
    client,
    'links',
    (api) => api.a2aLinks(),
    canDecide
  );
  const data = links.data;
  if (!canDecide || data === undefined) return null;
  if (data.links.length === 0 && data.offers.length === 0) return null;
  return (
    <SettingsGroup
      title="Links"
      requires="none"
      hint="Paired agents reached over a shared git branch, with no listener on either side. Messages wait on the branch while the other side is away."
      keywords="a2a link teammate branch git health"
    >
      {data.links.map((l) => (
        <SettingsRow
          key={l.alias}
          title={<span className="font-mono">a2a:{l.alias}</span>}
          subtitle={
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-mono">{l.remote}</span>
              <span>
                {l.pending
                  ? 'Waiting for the other side to start the link'
                  : l.ready
                    ? 'Ready'
                    : 'Not reached yet'}
                {l.lastExchangeAt === null
                  ? ''
                  : ` · last exchange ${formatShortDate(l.lastExchangeAt)}`}
                {` · ${l.waiting} waiting, ${l.unpublished} unpublished`}
              </span>
              {l.lastError !== null && <span>{l.lastError}</span>}
              {l.problems.map((p) => (
                <span key={p.subject}>{p.message}</span>
              ))}
            </span>
          }
        />
      ))}
      {data.offers.map((o) => (
        <SettingsRow
          key={o.pairedId}
          title={<span className="font-mono">a2a:{o.alias}</span>}
          subtitle={
            <span className="flex min-w-0 flex-col">
              <span>Waiting for their proof on the link</span>
              <span className="truncate font-mono">{o.remote}</span>
              {o.problems.map((p) => (
                <span key={p}>{p}</span>
              ))}
            </span>
          }
        />
      ))}
    </SettingsGroup>
  );
}

const PAIRING_STATE: Record<string, string> = {
  canceled: 'Canceled',
  expired: 'Expired',
  unpairing: 'Unpairing',
  unpaired: 'Unpaired',
};

/** This project's card key: its fingerprint for others to confirm, and a
 *  rotation the operator starts (paired peers re-pin from its statement). */
function KeysGroup({
  client,
  canOperate,
}: {
  client: Api;
  canOperate: boolean;
}) {
  const queryClient = useQueryClient();
  const keys = useA2AQuery(client, 'keys', (api) => api.a2aKeys());
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function rotate() {
    if (client === null) return;
    setError(null);
    try {
      const r = await client.rotateA2AKey(false);
      setResult(
        `New key ${r.fingerprint}.${r.untold.length > 0 ? ` Not reached yet (retried): ${r.untold.join(', ')}.` : ''}`
      );
      await queryClient.invalidateQueries({ queryKey: ['dispatch-a2a'] });
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <SettingsGroup
      title="Card key"
      requires="none"
      hint="The key this agent signs its card and paired requests with. Others confirm its fingerprint when they pair or upgrade."
      keywords="a2a key fingerprint rotate jwks"
    >
      <SettingsRow
        title="Fingerprint"
        subtitle={
          keys.isError ? (
            errorText(keys.error)
          ) : keys.data === undefined ? (
            'Loading…'
          ) : (
            <span className="flex min-w-0 flex-col">
              <span className="font-mono">{keys.data.current.fingerprint}</span>
              {keys.data.next !== null && (
                <span>
                  Rotating to{' '}
                  <span className="font-mono">
                    {keys.data.next.fingerprint}
                  </span>{' '}
                  until {formatShortDate(keys.data.next.until)}
                </span>
              )}
            </span>
          )
        }
        control={
          canOperate ? (
            <Button
              size="sm"
              variant="outline"
              disabled={keys.data?.next != null}
              onClick={() => setConfirming(true)}
            >
              <KeyRound />
              Rotate key
            </Button>
          ) : undefined
        }
      />
      {result !== null && <SettingsHint>{result}</SettingsHint>}
      <FieldProblem message={error} />
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rotate the card key?</AlertDialogTitle>
            <AlertDialogDescription>
              A new key signs at once. Paired peers are sent a statement from
              the old key and re-pin; both keys are served for 7 days.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void rotate()}>
              Rotate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsGroup>
  );
}
