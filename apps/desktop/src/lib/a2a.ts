// Pure helpers behind Settings → A2A and the Decline action on questions from
// A2A clients: the listener form, query keys, and reading what the daemon lists.
import type {
  A2AListenerSettings,
  A2AListenerStatus,
  A2ATaskSummary,
  Message,
} from '@dispatch/client';

import { gateOf } from './gates';

/** The port the form proposes for a listener that has never been opened. */
export const A2A_DEFAULT_PORT = 7450;

const LOOPBACK = '127.0.0.1';
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);
const A2A_CLIENT = /^agent:[^/]+\/a2a\./;
const TERMINAL_STATES = new Set([
  'COMPLETED',
  'FAILED',
  'CANCELED',
  'REJECTED',
]);

/** Every A2A query's key; they all start with `dispatch-a2a`, so an
 *  `a2a.changed` event refreshes them with one prefix. */
export function a2aQueryKey(
  baseUrl: string | undefined,
  what: 'listener' | 'card' | 'clients' | 'tasks'
): readonly unknown[] {
  return ['dispatch-a2a', baseUrl, what];
}

/** Whether a message was sent by an A2A client (`agent:<handle>/a2a.<name>`). */
export function isFromA2AClient(message: { from: string }): boolean {
  return A2A_CLIENT.test(message.from);
}

/** A blocking, non-gate question from an A2A client, which a deciding human
 *  may decline instead of answering. */
export function canDecline(message: Message, canDecide: boolean): boolean {
  return (
    canDecide &&
    isFromA2AClient(message) &&
    message.kind === 'question' &&
    message.blocking &&
    gateOf(message) === null
  );
}

/** The listener form as typed: every field a string except the two toggles. */
export interface ListenerForm {
  enabled: boolean;
  host: '127.0.0.1' | '0.0.0.0';
  port: string;
  publicUrl: string;
  certPath: string;
  keyPath: string;
  trustForwardedFor: boolean;
}

type FormResult =
  | { ok: true; settings: A2AListenerSettings }
  | { ok: false; field: keyof ListenerForm; error: string };

// A URL's host is this machine, where plain http is allowed.
function isLoopbackUrl(url: URL): boolean {
  return LOOPBACK_HOSTNAMES.has(url.hostname);
}

/** The form as the settings PUT /api/a2a/listener takes, or the first field
 *  the daemon would refuse, checked by the same rules it applies. */
export function formToSettings(form: ListenerForm): FormResult {
  const portText = form.port.trim();
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535) {
    return {
      ok: false,
      field: 'port',
      error: 'Port must be a number from 1 to 65535.',
    };
  }
  const loopback = form.host === LOOPBACK;
  const certPath = form.certPath.trim();
  const keyPath = form.keyPath.trim();
  if (!loopback && certPath === '') {
    return {
      ok: false,
      field: 'certPath',
      error: 'Every network interface needs TLS: give the certificate file.',
    };
  }
  if (certPath !== '' && keyPath === '') {
    return {
      ok: false,
      field: 'keyPath',
      error: 'TLS needs the key file as well as the certificate.',
    };
  }
  if (certPath === '' && keyPath !== '') {
    return {
      ok: false,
      field: 'certPath',
      error: 'TLS needs the certificate file as well as the key.',
    };
  }
  const publicUrl = form.publicUrl.trim();
  if (!loopback && publicUrl === '') {
    return {
      ok: false,
      field: 'publicUrl',
      error: 'Every network interface needs the https URL clients will use.',
    };
  }
  if (publicUrl !== '') {
    let url: URL;
    try {
      url = new URL(publicUrl);
    } catch {
      return { ok: false, field: 'publicUrl', error: 'This is not a URL.' };
    }
    if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && isLoopbackUrl(url))
    ) {
      return {
        ok: false,
        field: 'publicUrl',
        error: 'The public URL must be https unless it is this machine.',
      };
    }
  }
  return {
    ok: true,
    settings: {
      enabled: form.enabled,
      host: form.host,
      port,
      publicUrl: publicUrl === '' ? null : publicUrl,
      tls: certPath === '' ? null : { certPath, keyPath },
      // The daemon honours it only on loopback, behind a tunnel.
      trustForwardedFor: loopback && form.trustForwardedFor,
      standalone: false,
    },
  };
}

/** The form for a listener status. The status names only the URL, so a
 *  loopback URL gives the port, and any other URL is the public one. */
export function formFromStatus(
  status: A2AListenerStatus,
  teamTls: { certPath: string; keyPath: string } | null
): ListenerForm {
  const form: ListenerForm = {
    enabled: status.enabled,
    host: LOOPBACK,
    port: String(A2A_DEFAULT_PORT),
    publicUrl: '',
    certPath: teamTls?.certPath ?? '',
    keyPath: teamTls?.keyPath ?? '',
    trustForwardedFor: false,
  };
  if (status.url === null) return form;
  let url: URL;
  try {
    url = new URL(status.url);
  } catch {
    return form;
  }
  if (isLoopbackUrl(url) && url.port !== '') return { ...form, port: url.port };
  // A tunnel or proxy URL says nothing of the bound port; the owner confirms it.
  return { ...form, publicUrl: status.url, port: '' };
}

/** The status line under the listener switch. */
export function listenerStatusLine(status: A2AListenerStatus): string {
  if (status.error !== null) return `Closed: ${status.error}`;
  if (status.listening && status.url !== null) {
    return `Listening at ${status.url}`;
  }
  return 'Off';
}

/** The form field a daemon settings key (a 400's `field`) belongs to. */
export function listenerFieldOf(key: string): keyof ListenerForm | null {
  switch (key) {
    case 'host':
    case 'port':
    case 'publicUrl':
    case 'trustForwardedFor':
      return key;
    case 'tls':
    case 'tls.certPath':
      return 'certPath';
    case 'tls.keyPath':
      return 'keyPath';
    default:
      return null;
  }
}

/** Typed recipients as human addresses: a bare handle gains `human:`. */
export function parseRecipients(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .filter((part) => part !== '')
    .map((part) => (part.includes(':') ? part : `human:${part}`));
}

/** The unfinished tasks, grouped by client in the order the daemon listed them. */
export function openTasksByClient(
  tasks: readonly A2ATaskSummary[]
): Map<string, A2ATaskSummary[]> {
  const byClient = new Map<string, A2ATaskSummary[]>();
  for (const task of tasks) {
    if (TERMINAL_STATES.has(task.state)) continue;
    const list = byClient.get(task.client);
    if (list === undefined) byClient.set(task.client, [task]);
    else list.push(task);
  }
  return byClient;
}

/** What the card preview shows, read defensively from the card's JSON. */
export function cardSummary(card: Record<string, unknown>): {
  name: string;
  description: string;
  url: string | null;
  skills: string[];
} {
  const text = (value: unknown): string =>
    typeof value === 'string' ? value : '';
  const records = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value)
      ? value.filter(
          (v): v is Record<string, unknown> =>
            typeof v === 'object' && v !== null && !Array.isArray(v)
        )
      : [];
  const url = text(records(card.supportedInterfaces)[0]?.url);
  return {
    name: text(card.name),
    description: text(card.description),
    url: url === '' ? null : url,
    skills: records(card.skills)
      .map((skill) => text(skill.name) || text(skill.id))
      .filter((label) => label !== ''),
  };
}
