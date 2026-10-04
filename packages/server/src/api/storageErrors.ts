import { jsonResponse } from './http.js';

// The SQLite or errno code an error carries, when it carries one.
function codeOf(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

// Where a failed write was going, for the message; empty when unknown.
function pathOf(err: unknown): string {
  const path = (err as { path?: unknown }).path;
  return typeof path === 'string' ? ` (${path})` : '';
}

// Maps a storage failure to an answer a client can act on: a busy database is
// 503 with Retry-After, a write the disk refused is 507. Null for anything else.
export function storageErrorResponse(err: unknown): Response | null {
  const code = codeOf(err);
  if (code === null) return null;
  if (/^SQLITE_(BUSY|LOCKED)/.test(code)) {
    const res = jsonResponse(
      { error: 'the database is busy; retry shortly', code: 'busy' },
      503
    );
    res.headers.set('retry-after', '1');
    return res;
  }
  const storage = (error: string): Response =>
    jsonResponse({ error, code: 'storage' }, 507);
  if (code === 'ENOSPC' || code === 'EDQUOT' || code.startsWith('SQLITE_FULL'))
    return storage(
      `the disk is full${pathOf(err)}: free some space and try again`
    );
  if (code === 'EROFS' || code.startsWith('SQLITE_READONLY'))
    return storage(
      `the filesystem is read-only${pathOf(err)}: dispatch cannot write its state`
    );
  if (code === 'EACCES' || code === 'EPERM')
    return storage(
      `permission denied writing${pathOf(err)}: check the owner and mode of the project's .dispatch directory`
    );
  return null;
}
