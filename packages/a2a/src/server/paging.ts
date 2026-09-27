import { MessagingError } from '@dispatch/protocol';

// An opaque base64url of (status_at, id), the store's cursor.
export function encodePageToken(cursor: {
  statusAt: string;
  id: string;
}): string {
  return Buffer.from(JSON.stringify([cursor.statusAt, cursor.id])).toString(
    'base64url'
  );
}

export function decodePageToken(token: string): {
  statusAt: string;
  id: string;
} {
  let value: unknown = null;
  try {
    value = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    value = null;
  }
  if (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'string' &&
    typeof value[1] === 'string'
  ) {
    return { statusAt: value[0], id: value[1] };
  }
  throw new MessagingError(
    'invalid',
    'pageToken: not a token this agent issued',
    'pageToken'
  );
}
