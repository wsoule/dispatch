import { ApiError } from '@dispatch/client';
import type {
  LinearAccountView,
  LinearSignedInAccount,
  LinearSignInProblemCode,
} from '@dispatch/client';
import {
  Button,
  Chip,
  CopyValue,
  Dialog,
  Disclosure,
  Field,
  InitialsAvatar,
  Notice,
  Skeleton,
  Spinner,
  TextField,
  type UiTone,
} from '@dispatch/ui';
import { CheckCircle2 } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { describeError } from '../../lib/actionFeedback';
import {
  LINEAR_SIGN_IN_TAB_BLOCKED,
  openLinearSignIn,
  releaseLinearSignIn,
  reserveLinearSignIn,
} from '../../lib/linearSignIn';
import { useSettingsAccess } from './access';
import styles from './LinearAccount.module.css';
import { SettingsGroup, SettingsHint, SettingsRow } from './SettingsGroup';

/** The callback port a new setup suggests; the daemon's default too. */
const DEFAULT_LINEAR_CALLBACK_PORT = 47823;

/** What a teammate on someone else's Dispatch reads instead of a button. */
export const LINEAR_SIGN_IN_TEAMMATE =
  'Linear sign-in keeps your Linear token on your own computer, so it is not offered on someone else’s Dispatch. Your changes here reach Linear through this project’s connection.';

/** What a signed-in person reads about which changes carry their name. */
export const LINEAR_SIGNED_IN_SCOPE =
  'Your edits, new tasks and comments in this window reach Linear as you. Sync, imports, agents, the CLI and teammates still use the project connection.';

/** Linear granted no `write`, so the token is never used for a change. */
export const LINEAR_READ_ONLY_GRANT =
  'Linear granted read access only, so your changes still go through the project connection. Sign in again to grant write access.';

/** A stored sign-in this project cannot tie to its workspace right now. */
export const LINEAR_STORED_SIGN_IN =
  'Dispatch cannot check which Linear workspace this project uses right now, so this sign-in is not used here. Signing out ends it on this computer.';

/** Signed in, but the client ID that set up sign-in is gone from config. */
export const LINEAR_SIGN_IN_UNCONFIGURED =
  'Sign-in is no longer set up for this project. Your sign-in still works until you sign out; to sign in again, set it up first.';

/** Signed out here, but Linear did not confirm the grant ended. */
export const LINEAR_NOT_REVOKED =
  'Signed out here. Linear could not be reached to end the sign-in; remove Dispatch under your Linear account’s security settings to end it now.';

/** The redirect URI the daemon listens on for `port`, as Linear must have it. */
function linearCallbackUrl(port: number): string {
  return `http://127.0.0.1:${String(port)}/linear/callback`;
}

/** The colour a sign-in problem reads in: an ended or failed sign-in is
 *  danger, the rest (cancelled, timed out, wrong workspace) warning. */
function linearSignInProblemTone(code: LinearSignInProblemCode): UiTone {
  return code === 'ended' || code === 'failed' ? 'danger' : 'warning';
}

// A request the row made itself and its outcome, shown until the next one.
interface LocalProblem {
  message: string;
  tone: UiTone;
}

// A busy callback port is a setup question, not a failure; everything else a
// start, a cancel or a sign-out refuses reads as one.
function localProblem(err: unknown): LocalProblem {
  const message = describeError(err);
  const tone =
    err instanceof ApiError && err.code === 'linear_callback_port_busy'
      ? 'warning'
      : 'danger';
  return { message, tone };
}

/** One status line under a row, its tone in its text colour; the words say it. */
function ToneLine({ problem }: { problem: LocalProblem }) {
  return <SettingsHint tone={problem.tone}>{problem.message}</SettingsHint>;
}

// The client ID as config.yml would accept it: trimmed, no whitespace inside,
// at most 200 characters. Null when it would be refused.
function cleanClientId(draft: string): string | null {
  const id = draft.trim();
  return id === '' || id.length > 200 || /\s/.test(id) ? null : id;
}

// The callback port as config.yml would accept it, or null.
function cleanPort(draft: string): number | null {
  const port = Number(draft.trim());
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null;
}

/**
 * The one-time setup a Linear workspace admin does: register an OAuth app in
 * Linear with the callback URL shown here, then paste its client ID. Saving
 * writes `linear.oauthClientId` and `linear.oauthCallbackPort` to the
 * project's config, which only the person running Dispatch may change.
 */
function LinearSignInSetupDialog({
  open,
  onClose,
  clientIdSource,
  clientId,
  port,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  clientIdSource: LinearAccountView['clientIdSource'];
  /** The saved `linear.oauthClientId`, or null. */
  clientId: string | null;
  /** The saved `linear.oauthCallbackPort`. */
  port: number;
  onSave: DispatchProjectData['handleUpdateConfig'];
}) {
  const { canOperate, operateReason } = useSettingsAccess();
  const fromEnv = clientIdSource === 'env';
  const [idDraft, setIdDraft] = useState(clientId ?? '');
  const [portDraft, setPortDraft] = useState(String(port));
  const [portOpen, setPortOpen] = useState(
    port !== DEFAULT_LINEAR_CALLBACK_PORT
  );
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Each opening starts from what is saved.
  useEffect(() => {
    if (!open) return;
    setIdDraft(clientId ?? '');
    setPortDraft(String(port));
    setPortOpen(port !== DEFAULT_LINEAR_CALLBACK_PORT);
    setTouched(false);
    setSaveError(null);
  }, [open, clientId, port]);

  const nextId = cleanClientId(idDraft);
  const nextPort = cleanPort(portDraft);
  const idError =
    !fromEnv && touched && nextId === null
      ? 'Paste the client ID from Linear: no spaces, at most 200 characters.'
      : undefined;
  const portError =
    nextPort === null ? 'Use a whole number from 1024 to 65535.' : undefined;
  const valid = nextPort !== null && (fromEnv || nextId !== null);

  async function save() {
    setTouched(true);
    if (!valid || nextPort === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave({
        linear: {
          // Under the env var the field is read-only and config keeps its own.
          ...(fromEnv ? {} : { oauthClientId: nextId }),
          oauthCallbackPort: nextPort,
        },
      });
      onClose();
    } catch (err) {
      setSaveError(describeError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Set up Linear sign-in"
      description="A Linear workspace admin does this once per OAuth application."
      dismissible={!saving}
      data-testid="linear-sign-in-setup"
      actions={
        <>
          <Button variant="secondary" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            busy={saving}
            disabled={!canOperate || (touched && !valid)}
            onClick={() => void save()}
          >
            Save
          </Button>
        </>
      }
    >
      <div className={styles.setup}>
        {!canOperate && (
          <Notice role="note" tone="default">
            {operateReason}
          </Notice>
        )}
        <p className={styles.para}>
          In Linear, open Settings → Administration → API and create an OAuth
          application. Use this callback URL exactly:
        </p>
        <CopyValue
          value={linearCallbackUrl(nextPort ?? port)}
          label="callback URL"
          data-testid="linear-callback-url"
        />
        <p className={styles.para}>
          Turn on Public if people in other Linear workspaces will sign in.
          Dispatch does not use the client secret; do not paste it anywhere.
        </p>
        <Field
          label="Client ID"
          id="linear-oauth-client-id"
          hint={fromEnv ? 'Set by DISPATCH_LINEAR_CLIENT_ID.' : undefined}
          error={idError}
        >
          <TextField
            value={fromEnv ? '' : idDraft}
            placeholder={fromEnv ? 'From the environment' : undefined}
            readOnly={fromEnv}
            disabled={!canOperate}
            autoComplete="off"
            spellCheck={false}
            className={styles.mono}
            onChange={(e) => setIdDraft(e.target.value)}
            onBlur={() => setTouched(true)}
          />
        </Field>
        <Disclosure
          summary="Callback port"
          open={portOpen}
          onOpenChange={setPortOpen}
          keepMounted
        >
          <Field
            label="Callback port"
            id="linear-oauth-callback-port"
            hint="Change it only if another app uses this port, and update the callback URL in Linear to match."
            error={portError}
          >
            <TextField
              value={portDraft}
              inputMode="numeric"
              disabled={!canOperate}
              className={styles.port}
              onChange={(e) => setPortDraft(e.target.value)}
            />
          </Field>
        </Disclosure>
        <p className={styles.para}>
          Saving writes the client ID to .dispatch/config.yml. Commit it so
          teammates get sign-in too.
        </p>
        {saveError !== null && (
          <ToneLine problem={{ message: saveError, tone: 'danger' }} />
        )}
      </div>
    </Dialog>
  );
}

/**
 * Settings → Linear → "Your Linear account": the person running Dispatch
 * signs in with their own Linear account, so the changes they make here
 * reach Linear as them instead of as the project's API key. Linear's consent
 * page opens in the system browser; the daemon hears back on a loopback
 * port and keeps the token on this computer. Teammates, and a window that
 * attached without the app token, read why it is not offered.
 */
export function LinearAccountGroup({ data }: { data: DispatchProjectData }) {
  const view = data.linearAccount;
  const { operateReason } = useSettingsAccess();
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  // The workspace whose sign-out is in flight, if any.
  const [signingOut, setSigningOut] = useState<string | null>(null);
  const [problem, setProblem] = useState<LocalProblem | null>(null);
  const [notRevoked, setNotRevoked] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);

  // An older daemon has no account route: nothing to offer.
  if (view === null && data.linearAccountError != null) return null;

  async function signIn(anotherWorkspace: boolean) {
    setProblem(null);
    setNotRevoked(false);
    // Inside the click: a browser blocks a tab opened after the await.
    const target = reserveLinearSignIn();
    if (target.kind === 'blocked') {
      setProblem({ message: LINEAR_SIGN_IN_TAB_BLOCKED, tone: 'warning' });
      return;
    }
    setStarting(true);
    try {
      let authorizeUrl: string;
      try {
        ({ authorizeUrl } = await data.handleLinearSignIn(
          anotherWorkspace ? { anotherWorkspace: true } : undefined
        ));
      } catch (err) {
        releaseLinearSignIn(target);
        setProblem(localProblem(err));
        return;
      }
      try {
        await openLinearSignIn(authorizeUrl, target);
      } catch (err) {
        // Nothing opened, so stop the daemon waiting for a redirect.
        setProblem(localProblem(err));
        await data.handleCancelLinearSignIn().catch(() => undefined);
      }
    } finally {
      setStarting(false);
    }
  }

  async function cancel() {
    setProblem(null);
    setCancelling(true);
    try {
      await data.handleCancelLinearSignIn();
    } catch (err) {
      setProblem(localProblem(err));
    } finally {
      setCancelling(false);
    }
  }

  // Signs out of the sign-in the row shows, by its workspace, so the daemon
  // never needs Linear to say which one that is.
  async function signOut(workspaceId: string) {
    setProblem(null);
    setNotRevoked(false);
    setSigningOut(workspaceId);
    try {
      const { revoked } = await data.handleLinearSignOut({ workspaceId });
      setNotRevoked(!revoked);
    } catch (err) {
      setProblem(localProblem(err));
    } finally {
      setSigningOut(null);
    }
  }

  const config = data.config;
  const setupDialog =
    view !== null && config !== null ? (
      <LinearSignInSetupDialog
        open={setupOpen}
        onClose={() => setSetupOpen(false)}
        clientIdSource={view.clientIdSource}
        clientId={config.linear.oauthClientId ?? null}
        port={config.linear.oauthCallbackPort ?? DEFAULT_LINEAR_CALLBACK_PORT}
        onSave={data.handleUpdateConfig}
      />
    ) : null;

  // "Signed in as …" with its Sign out, for the project's own sign-in or
  // one stored on this computer that the project cannot place right now.
  function accountRow(
    account: LinearSignedInAccount,
    subtitle: string,
    hints: ReactNode
  ) {
    const workspaceId = account.workspace.id;
    return (
      <SettingsRow
        key={workspaceId}
        title={
          <span className={styles.titleLine}>
            <InitialsAvatar name={account.name} size="sm" />
            <CheckCircle2
              aria-hidden
              size={14}
              strokeWidth={1.8}
              data-tone="success"
              className={styles.check}
            />
            <span>
              {`Signed in as ${account.name}`}
              {account.email !== '' && ` (${account.email})`}
              {` in ${account.workspace.name}`}
            </span>
            {account.guest && <Chip tone="muted">Guest</Chip>}
          </span>
        }
        subtitle={subtitle}
        keywords="sign out oauth"
        control={
          <Button
            variant="secondary"
            size="sm"
            busy={signingOut === workspaceId}
            disabled={signingOut !== null && signingOut !== workspaceId}
            onClick={() => void signOut(workspaceId)}
          >
            Sign out
          </Button>
        }
      >
        {hints}
        {problem !== null && <ToneLine problem={problem} />}
      </SettingsRow>
    );
  }

  // After a sign-out Linear did not confirm, under whichever row follows.
  const notRevokedNotice = notRevoked ? (
    <Notice role="status" tone="warning">
      {LINEAR_NOT_REVOKED}
    </Notice>
  ) : null;

  // The one-time setup, offered when no client ID resolves.
  function setupRow() {
    return (
      <SettingsRow
        title="Sign in with Linear"
        subtitle="Sign in with Linear needs a one-time setup by a Linear workspace admin."
        control={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setSetupOpen(true)}
          >
            Set up sign-in
          </Button>
        }
      >
        {notRevokedNotice}
      </SettingsRow>
    );
  }

  function rows() {
    if (view === null) {
      return (
        <SettingsRow
          title="Sign in with Linear"
          subtitle={<Skeleton width={240} height={12} />}
        />
      );
    }
    if (view.unavailable === 'teammate') {
      return (
        <SettingsRow
          title="Sign in with Linear"
          subtitle={LINEAR_SIGN_IN_TEAMMATE}
        />
      );
    }
    if (view.unavailable === 'attached') {
      return (
        <SettingsRow title="Sign in with Linear" subtitle={operateReason} />
      );
    }
    if (view.pending) {
      return (
        <SettingsRow
          title={
            <span className={styles.titleLine}>
              <Spinner size="xs" label="" />
              Finish signing in in your browser.
            </span>
          }
          subtitle="Linear’s sign-in page opened in your browser. Approve Dispatch there, then come back."
          control={
            <Button
              variant="secondary"
              size="sm"
              busy={cancelling}
              onClick={() => void cancel()}
            >
              Cancel
            </Button>
          }
        >
          {problem !== null && <ToneLine problem={problem} />}
        </SettingsRow>
      );
    }
    const { account, connection } = view;
    // A sign-in is shown, with its Sign out, whatever the setup says.
    if (account !== null) {
      const differentUser =
        connection !== null && connection.userId !== account.userId;
      return accountRow(
        account,
        LINEAR_SIGNED_IN_SCOPE,
        <>
          {view.unavailable === 'not-configured' && (
            <ToneLine
              problem={{
                message: LINEAR_SIGN_IN_UNCONFIGURED,
                tone: 'warning',
              }}
            />
          )}
          {differentUser && (
            <SettingsHint>
              {`Tasks assigned to you still map to ${connection.userName} in Linear.`}
            </SettingsHint>
          )}
          {!account.canWrite && (
            <ToneLine
              problem={{ message: LINEAR_READ_ONLY_GRANT, tone: 'warning' }}
            />
          )}
        </>
      );
    }
    // Sign-ins on this computer the project cannot place right now.
    const stored = view.stored.map((s) =>
      accountRow(s, LINEAR_STORED_SIGN_IN, null)
    );
    if (view.unavailable === 'not-connected') {
      return (
        <>
          {stored}
          <SettingsRow
            title="Sign in with Linear"
            subtitle="Connect this project to Linear with an API key first."
          >
            {notRevokedNotice}
          </SettingsRow>
        </>
      );
    }
    if (view.unavailable === 'not-configured') {
      return (
        <>
          {stored}
          {setupRow()}
        </>
      );
    }
    const shown: LocalProblem | null =
      problem ??
      (view.problem === null
        ? null
        : {
            message: view.problem.message,
            tone: linearSignInProblemTone(view.problem.code),
          });
    const wrongWorkspace =
      problem === null && view.problem?.code === 'wrong-workspace';
    return (
      <>
        {stored}
        <SettingsRow
          title="Not signed in"
          subtitle={`Sign in so the changes you make here reach Linear as you. Until then they go ${
            connection === null
              ? 'through the project connection'
              : `as ${connection.userName}`
          }.`}
          keywords="oauth account"
          control={
            <span className={styles.actions}>
              {wrongWorkspace && (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={starting}
                  onClick={() => void signIn(true)}
                >
                  Sign in with another workspace
                </Button>
              )}
              <Button
                variant="primary"
                size="sm"
                busy={starting}
                onClick={() => void signIn(false)}
              >
                Sign in with Linear
              </Button>
            </span>
          }
        >
          {notRevokedNotice}
          {shown !== null && <ToneLine problem={shown} />}
        </SettingsRow>
        <SettingsRow
          title="Sign-in setup"
          subtitle={
            view.clientIdSource === 'env'
              ? 'The client ID comes from DISPATCH_LINEAR_CLIENT_ID. Linear sends you back to the callback URL below.'
              : 'The client ID is saved in .dispatch/config.yml. Linear sends you back to the callback URL below.'
          }
          keywords="client id callback port oauth application"
          stacked
          control={
            <span className={styles.setupLine}>
              <CopyValue value={view.callbackUrl} label="callback URL" />
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setSetupOpen(true)}
              >
                Edit setup
              </Button>
            </span>
          }
        />
      </>
    );
  }

  return (
    <SettingsGroup
      title="Your Linear account"
      hint="Your own Linear sign-in. Its token stays on this computer, never in the repo."
      keywords="linear sign in oauth account"
      requires="none"
    >
      {rows()}
      {setupDialog}
    </SettingsGroup>
  );
}
