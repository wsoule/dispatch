// Linear credentials as text. Every Linear credential starts with `lin_api_`
// (a personal API key) or `lin_oauth_` (an OAuth token), so one pattern finds
// them in log lines and error messages. From Better Tracker's core/secrets.ts.

const CREDENTIAL_SOURCE = 'lin_(api|oauth)_[A-Za-z0-9_-]{16,}';

/** Replaces each credential-shaped run with `lin_<kind>_[redacted]`. Pure. */
export function redactLinearSecrets(text: string): string {
  if (typeof text !== 'string' || !text.includes('lin_')) return text;
  return text.replace(
    new RegExp(CREDENTIAL_SOURCE, 'g'),
    (_match, kind: string) => `lin_${kind}_[redacted]`
  );
}
