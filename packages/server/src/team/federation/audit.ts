// Every kind fed_audit records (spec "The audit log"); FedStore.audit takes
// only these, and each emitting feature writes and tests its own.
export const AUDIT_KINDS = [
  'founding',
  'trust',
  'invite',
  'admission',
  'role',
  'hosts',
  'observer',
  'license',
  'revocation',
  'recovery',
  'legacy-close',
  'transport',
  'dismiss',
  'fork',
  'halt',
  'bad-signature',
  'speaks-for',
  'refused-message',
  'run-conflict',
  'clock-hold',
] as const;

export type AuditKind = (typeof AUDIT_KINDS)[number];
