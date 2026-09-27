#!/usr/bin/env bun
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';

/**
 * Makes the key pair Dispatch licenses are signed with. Run once, by whoever
 * issues licenses:
 *
 *   bun scripts/license-keygen.ts ~/secure/dispatch-license-signing.pem
 *
 * The private key goes to the path given, 0600, and is never printed: keep it
 * off this repository and out of CI. The public key is printed, to paste into
 * LICENSE_PUBLIC_KEY in packages/federation/src/license.ts — from then on
 * builds verify keys signed with the private one.
 */

const out = process.argv[2];
if (out === undefined) {
  console.error('usage: bun scripts/license-keygen.ts <private-key-path>');
  process.exit(2);
}
if (existsSync(out)) {
  // Overwriting would orphan every license already issued with the old key.
  console.error(`${out} exists; refusing to overwrite a signing key`);
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
writeFileSync(
  out,
  privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  { mode: 0o600 }
);
console.log(
  `Private key written to ${out}. Keep it safe; it is what makes a license real.\n`
);
console.log(
  'Paste this as LICENSE_PUBLIC_KEY in packages/federation/src/license.ts:\n'
);
console.log(publicKey.export({ type: 'spki', format: 'pem' }).toString());
