import { AgentCard, verifyAgentCardSignature } from '@a2a-js/sdk';
import { buildCardJson } from '@dispatch/a2a';
import { credentialsPath } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';

import { CardSigner, loadOrCreateSigningKey } from '../../src/a2a/signing.js';
import { useTempProject } from '../messaging/harness.js';
import { bridgeFixture } from './fixture.js';

const project = useTempProject();

describe('the signing key', () => {
  it('is made once per project in the 0600 credentials file, and reused with the same kid', () => {
    const first = loadOrCreateSigningKey(project.root());
    expect(statSync(credentialsPath()).mode & 0o777).toBe(0o600);
    expect(loadOrCreateSigningKey(project.root()).kid).toBe(first.kid);
    expect(first.publicJwk).toMatchObject({
      kty: 'EC',
      crv: 'P-256',
      kid: first.kid,
    });
    expect(first.publicJwk).not.toHaveProperty('d');
    expect(readFileSync(credentialsPath(), 'utf8')).toContain(
      first.privateJwk.d
    );
  });
});

describe('the daemon card', () => {
  let f: Awaited<ReturnType<typeof bridgeFixture>>;
  let signer: CardSigner;
  beforeEach(async () => {
    f = await bridgeFixture(project.root());
    signer = new CardSigner(loadOrCreateSigningKey(project.root()));
    f.deps.signer = () => signer;
  });
  afterEach(() => f.close());

  it('is signed with jku at the public URL it is built for, and verifies', async () => {
    const inputs = await f.port.card({
      publicUrl: 'https://relay.example.com',
    });
    const [signature] = inputs.signatures ?? [];
    const header = JSON.parse(
      Buffer.from(signature.protected, 'base64url').toString('utf8')
    ) as { jku: string; kid: string };
    expect(header.jku).toBe('https://relay.example.com/.well-known/jwks.json');
    const key = inputs.jwks?.keys.find((k) => k.kid === header.kid);
    await expect(
      verifyAgentCardSignature(() => Promise.resolve(key as never))(
        AgentCard.fromJSON(buildCardJson(inputs))
      )
    ).resolves.toBeUndefined();
  });

  it('publishes public keys only', async () => {
    const inputs = await f.port.card();
    const text = JSON.stringify(inputs.jwks);
    expect(inputs.jwks?.keys).toHaveLength(1);
    expect(inputs.jwks?.keys[0]).not.toHaveProperty('d');
    expect(text).not.toContain(
      loadOrCreateSigningKey(project.root()).privateJwk.d
    );
  });

  it('signs once per distinct card, again for another public URL, and turns push off for a standalone host', async () => {
    const a = await f.port.card();
    const b = await f.port.card();
    expect(b.signatures).toEqual(a.signatures);
    const relay = await f.port.card({
      publicUrl: 'https://relay.example.com',
      standalone: true,
    });
    expect(relay.signatures).not.toEqual(a.signatures);
    expect(relay.pushNotifications).toBe(false);
    expect(a.pushNotifications).toBe(true);
  });

  it('serves the card unsigned when there is no signer', async () => {
    f.deps.signer = () => null;
    const inputs = await f.port.card();
    expect(inputs.signatures).toBeUndefined();
    expect(inputs.jwks).toBeUndefined();
  });
});
