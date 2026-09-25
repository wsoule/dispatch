import type {
  ConfigPatch,
  DispatchConfig,
  RemoteConfig,
} from '@dispatch/core/browser';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { SettingsGroup, SettingsRow } from './SettingsGroup';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';

interface Props {
  config: DispatchConfig;
  /** Resolves `false` when the save was refused; a form keeps its draft then. */
  onSave: (patch: ConfigPatch) => Promise<unknown>;
  canOperate: boolean;
}

/** `user@host:port path` — a remote the way a person reads one. */
export function describeRemote(remote: RemoteConfig): string {
  const who = remote.user === undefined ? '' : `${remote.user}@`;
  const port = remote.port === undefined ? '' : `:${remote.port}`;
  const path = remote.path === undefined ? '' : `  ${remote.path}`;
  return `${who}${remote.host}${port}${path}`;
}

/** The fields of the add form as a RemoteConfig, or null while it is not one. */
export function remoteFromForm(form: {
  host: string;
  user: string;
  port: string;
  path: string;
  identityFile: string;
}): RemoteConfig | null {
  const host = form.host.trim();
  if (host === '') return null;
  const port = form.port.trim();
  if (port !== '' && !/^\d+$/.test(port)) return null;
  return {
    host,
    ...(form.user.trim() === '' ? {} : { user: form.user.trim() }),
    ...(port === '' ? {} : { port: Number(port) }),
    ...(form.path.trim() === '' ? {} : { path: form.path.trim() }),
    ...(form.identityFile.trim() === ''
      ? {}
      : { identityFile: form.identityFile.trim() }),
  };
}

const EMPTY = {
  name: '',
  host: '',
  user: '',
  port: '',
  path: '',
  identityFile: '',
};

/**
 * Settings → Remotes: machines reachable over ssh that terminals can open on
 * (`dispatch remote exec`, `dispatch remote forward`). Everything else about
 * the connection comes from ~/.ssh/config. Owner only: a remote is where this
 * machine's credentials get used.
 */
export function RemotesSection({ config, onSave, canOperate }: Props) {
  const remotes = Object.entries(config.remotes ?? {});
  const [form, setForm] = useState(EMPTY);
  const set = (field: keyof typeof EMPTY) => (value: string) =>
    setForm((f) => ({ ...f, [field]: value }));
  const next = remoteFromForm(form);
  const name = form.name.trim();

  return (
    <>
      <SettingsGroup
        title="Machines"
        hint="Terminals can open on these. Agents still run on this machine."
        keywords="ssh remotes hosts"
      >
        {remotes.length === 0 && (
          <SettingsRow
            title="None yet"
            subtitle="Hosts from your ssh config work, so keys and jump hosts stay there."
          />
        )}
        {remotes.map(([id, remote]) => (
          <SettingsRow
            key={id}
            title={id}
            subtitle={
              <span className="font-mono">{describeRemote(remote)}</span>
            }
            locked={!canOperate}
            control={
              canOperate ? (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove ${id}`}
                  onClick={() => void onSave({ remotes: { [id]: null } })}
                >
                  <Trash2 />
                </Button>
              ) : undefined
            }
          />
        ))}
      </SettingsGroup>
      <SettingsGroup title="Add a machine" keywords="ssh remote">
        {canOperate ? (
          <SettingsRow title="Connection" htmlFor="remote-name" stacked>
            <form
              className="grid grid-cols-2 gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (name === '' || next === null) return;
                void onSave({ remotes: { [name]: next } }).then((saved) => {
                  if (saved !== false) setForm(EMPTY);
                });
              }}
            >
              <Input
                id="remote-name"
                aria-label="Name"
                value={form.name}
                onChange={(e) => set('name')(e.target.value)}
                placeholder="build-box"
              />
              <Input
                aria-label="Host"
                value={form.host}
                onChange={(e) => set('host')(e.target.value)}
                placeholder="build-box.internal"
              />
              <Input
                aria-label="User"
                value={form.user}
                onChange={(e) => set('user')(e.target.value)}
                placeholder="user (optional)"
              />
              <Input
                aria-label="Port"
                value={form.port}
                inputMode="numeric"
                onChange={(e) => set('port')(e.target.value)}
                placeholder="port (optional)"
              />
              <Input
                aria-label="Checkout path"
                value={form.path}
                onChange={(e) => set('path')(e.target.value)}
                placeholder="/srv/repo (optional)"
                className="font-mono"
              />
              <Input
                aria-label="Identity file"
                value={form.identityFile}
                onChange={(e) => set('identityFile')(e.target.value)}
                placeholder="~/.ssh/id_ed25519 (optional)"
                className="font-mono"
              />
              <Button
                type="submit"
                variant="outline"
                className="col-span-2 justify-self-start"
                disabled={name === '' || next === null}
              >
                <Plus />
                Add machine
              </Button>
            </form>
          </SettingsRow>
        ) : (
          <SettingsRow title="Add a machine" locked />
        )}
      </SettingsGroup>
    </>
  );
}
