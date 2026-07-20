import type {
  CreateInput,
  DispatchConfig,
  TaskDoc,
  UpdatePatch,
} from '@dispatch/core';

// Empty string means "same origin" — dispatchd serves this app's own static
// files in production, so the common case needs no base URL at all. A
// non-empty value is the seam a future Tauri desktop shell uses to point this
// same UI at a daemon running on some other port (see spec §2).
const baseUrl = import.meta.env.VITE_DISPATCH_URL ?? '';

export interface HealthPayload {
  ok: boolean;
  version: string;
  rootDir: string;
}

export interface TaskFilter {
  status?: string;
  kind?: string;
  parent?: string;
}

// Shared fetch wrapper: resolves against `baseUrl`, throws with the server's
// `{ error }` message (falling back to the status code) on any non-2xx
// response, and parses the body as JSON on success. Every typed fetcher below
// is a thin wrapper around this.
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `request failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

function jsonBody(value: unknown): RequestInit {
  return {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  };
}

export function fetchHealth(): Promise<HealthPayload> {
  return request('/api/health');
}

export function fetchConfig(): Promise<DispatchConfig> {
  return request('/api/config');
}

// Pure helper (no fetch involved) so the query-string shape is unit
// testable without a network layer: `?` + params when any filter is set, ''
// otherwise, in the same status/kind/parent order the server accepts.
export function taskQueryString(filter: TaskFilter = {}): string {
  const params = new URLSearchParams();
  if (filter.status !== undefined) params.set('status', filter.status);
  if (filter.kind !== undefined) params.set('kind', filter.kind);
  if (filter.parent !== undefined) params.set('parent', filter.parent);
  return params.size > 0 ? `?${params.toString()}` : '';
}

export function fetchTasks(filter: TaskFilter = {}): Promise<TaskDoc[]> {
  return request(`/api/tasks${taskQueryString(filter)}`);
}

export function fetchReadyTasks(): Promise<TaskDoc[]> {
  return request('/api/tasks/ready');
}

export function fetchTask(id: string): Promise<TaskDoc> {
  return request(`/api/tasks/${id}`);
}

export function createTask(input: CreateInput): Promise<TaskDoc> {
  return request('/api/tasks', { method: 'POST', ...jsonBody(input) });
}

export function updateTask(id: string, patch: UpdatePatch): Promise<TaskDoc> {
  return request(`/api/tasks/${id}`, { method: 'PATCH', ...jsonBody(patch) });
}

// Pure helper: swaps an http(s) origin for its ws(s) equivalent and appends
// `/ws`. Kept separate from `wsUrl` below (which touches `window`) so it's
// unit testable without a DOM.
export function httpToWs(origin: string): string {
  return `${origin.replace(/^http/, 'ws')}/ws`;
}

// Derives the WS URL from `baseUrl`, falling back to the page's own origin
// when it's empty (the same-origin default case).
export function wsUrl(): string {
  return httpToWs(baseUrl !== '' ? baseUrl : window.location.origin);
}

export type ServerEvent =
  | { type: 'task.changed' }
  | { type: 'hello'; version: string };

// Opens a WS connection to dispatchd and calls `onChange` for every
// `task.changed` event. Reconnects on close/error with a fixed 1s backoff —
// the protocol is "go refetch," not a diff, so a connection dropping for a
// second just means the UI is briefly less live, never wrong. Returns a
// disposer that stops reconnecting and closes the current socket.
export function connectEvents(onChange: () => void): () => void {
  let closed = false;
  let socket: WebSocket | null = null;

  function scheduleReconnect() {
    if (closed) return;
    setTimeout(connect, 1000);
  }

  function connect() {
    if (closed) return;
    socket = new WebSocket(wsUrl());
    socket.addEventListener('message', (event) => {
      const data = JSON.parse(event.data as string) as ServerEvent;
      if (data.type === 'task.changed') onChange();
    });
    socket.addEventListener('close', scheduleReconnect);
    socket.addEventListener('error', scheduleReconnect);
  }

  connect();
  return () => {
    closed = true;
    socket?.close();
  };
}
