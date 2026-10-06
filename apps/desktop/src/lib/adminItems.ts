import type { SettingsPage } from './appNav';

/** Something waiting on an admin that has no other home than Settings. */
export interface AdminItem {
  label: string;
  page: SettingsPage;
  count: number;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The muted "settings ·n": machines to trust, refused peers, pending clients, skipped files. */
export function adminItems(counts: {
  waitingMachines?: number;
  refusedPeers?: number;
  pendingClients?: number;
  skippedFiles?: number;
}): AdminItem[] {
  const items: AdminItem[] = [];
  const add = (
    count: number | undefined,
    label: string,
    page: SettingsPage
  ) => {
    if (count !== undefined && count > 0) items.push({ label, page, count });
  };
  const m = counts.waitingMachines ?? 0;
  add(m, `${plural(m, 'machine', 'machines')} waiting to join`, 'team');
  const p = counts.refusedPeers ?? 0;
  add(p, `${plural(p, 'peer credential', 'peer credentials')} refused`, 'a2a');
  const c = counts.pendingClients ?? 0;
  add(c, `${plural(c, 'A2A client', 'A2A clients')} pending`, 'a2a');
  const f = counts.skippedFiles ?? 0;
  add(f, `${plural(f, 'Claude file', 'Claude files')} skipped`, 'memory');
  return items;
}
