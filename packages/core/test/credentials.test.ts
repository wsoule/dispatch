import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  clearCredential,
  credentialsPath,
  readCredentials,
  resolveLinearApiKey,
  writeCredential,
} from '../src/credentials.js';

let fakeHome: string;
const originalHome = process.env.DISPATCH_HOME;
const originalKey = process.env.LINEAR_API_KEY;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-credentials-'));
  process.env.DISPATCH_HOME = fakeHome;
  delete process.env.LINEAR_API_KEY;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  if (originalKey === undefined) delete process.env.LINEAR_API_KEY;
  else process.env.LINEAR_API_KEY = originalKey;
});

describe('credentials file', () => {
  it('lives at $DISPATCH_HOME/.dispatch/credentials.json', () => {
    expect(credentialsPath()).toBe(
      join(fakeHome, '.dispatch', 'credentials.json')
    );
  });

  it('is written owner-read/write only', () => {
    writeCredential('linear', { apiKey: 'test-key-value' });
    expect(statSync(credentialsPath()).mode & 0o777).toBe(0o600);
  });

  it('stays 0600 when an existing file is overwritten', () => {
    mkdirSync(join(fakeHome, '.dispatch'), { recursive: true });
    writeFileSync(credentialsPath(), '{}\n', { mode: 0o644 });
    writeCredential('linear', { apiKey: 'test-key-value' });
    expect(statSync(credentialsPath()).mode & 0o777).toBe(0o600);
  });

  it('reads back what was written, and clears it again', () => {
    writeCredential('linear', { apiKey: 'test-key-value' });
    expect(readCredentials().linear?.apiKey).toBe('test-key-value');
    clearCredential('linear');
    expect(readCredentials().linear).toBeUndefined();
  });

  it('treats a corrupt file as no credentials rather than throwing', () => {
    mkdirSync(join(fakeHome, '.dispatch'), { recursive: true });
    writeFileSync(credentialsPath(), '{ not json');
    expect(readCredentials()).toEqual({});
  });
});

describe('resolveLinearApiKey', () => {
  it('reports no key when nothing is configured', () => {
    expect(resolveLinearApiKey()).toEqual({ apiKey: null, source: null });
  });

  it('prefers the environment over the stored file', () => {
    writeCredential('linear', { apiKey: 'from-file' });
    process.env.LINEAR_API_KEY = 'from-env';
    expect(resolveLinearApiKey()).toEqual({
      apiKey: 'from-env',
      source: 'env',
    });
  });

  it('falls back to the stored file when the env var is blank', () => {
    writeCredential('linear', { apiKey: 'from-file' });
    process.env.LINEAR_API_KEY = '   ';
    expect(resolveLinearApiKey()).toEqual({
      apiKey: 'from-file',
      source: 'file',
    });
  });
});
