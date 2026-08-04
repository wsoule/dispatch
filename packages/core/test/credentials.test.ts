import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  clearCredential,
  clearProjectCredential,
  credentialsPath,
  readCredentials,
  resolveLinearApiKey,
  writeCredential,
  writeProjectCredential,
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

describe('per-project credentials', () => {
  const projectA = '/tmp/dispatch-project-a';
  const projectB = '/tmp/dispatch-project-b';

  it('stores a key against one project without touching the global one', () => {
    writeCredential('linear', { apiKey: 'global-key' });
    writeProjectCredential(projectA, 'linear', { apiKey: 'a-key' });

    const file = readCredentials();
    expect(file.linear?.apiKey).toBe('global-key');
    expect(file.projects?.[projectA]?.linear?.apiKey).toBe('a-key');
  });

  it('keeps two projects independent', () => {
    writeProjectCredential(projectA, 'linear', { apiKey: 'a-key' });
    writeProjectCredential(projectB, 'linear', { apiKey: 'b-key' });

    expect(resolveLinearApiKey(projectA).apiKey).toBe('a-key');
    expect(resolveLinearApiKey(projectB).apiKey).toBe('b-key');
  });

  it('treats a trailing slash as the same project', () => {
    writeProjectCredential(projectA, 'linear', { apiKey: 'a-key' });
    expect(resolveLinearApiKey(`${projectA}/`).apiKey).toBe('a-key');
  });

  it('clears only the named project and prunes its emptied entry', () => {
    writeCredential('linear', { apiKey: 'global-key' });
    writeProjectCredential(projectA, 'linear', { apiKey: 'a-key' });
    writeProjectCredential(projectB, 'linear', { apiKey: 'b-key' });

    clearProjectCredential(projectA, 'linear');

    const file = readCredentials();
    expect(file.projects?.[projectA]).toBeUndefined();
    expect(file.projects?.[projectB]?.linear?.apiKey).toBe('b-key');
    expect(file.linear?.apiKey).toBe('global-key');
  });

  it('is a no-op when clearing a project that was never connected', () => {
    writeProjectCredential(projectB, 'linear', { apiKey: 'b-key' });
    clearProjectCredential(projectA, 'linear');
    expect(readCredentials().projects?.[projectB]?.linear?.apiKey).toBe(
      'b-key'
    );
  });

  it('is written owner-read/write only', () => {
    writeProjectCredential(projectA, 'linear', { apiKey: 'a-key' });
    expect(statSync(credentialsPath()).mode & 0o777).toBe(0o600);
  });
});

describe('resolveLinearApiKey', () => {
  const project = '/tmp/dispatch-project-a';

  it('reports no key when nothing is configured', () => {
    expect(resolveLinearApiKey(project)).toEqual({
      apiKey: null,
      source: null,
    });
  });

  it('prefers the project key over the environment', () => {
    writeProjectCredential(project, 'linear', { apiKey: 'from-project' });
    process.env.LINEAR_API_KEY = 'from-env';
    expect(resolveLinearApiKey(project)).toEqual({
      apiKey: 'from-project',
      source: 'project',
    });
  });

  it('prefers the environment over the global key', () => {
    writeCredential('linear', { apiKey: 'from-global' });
    process.env.LINEAR_API_KEY = 'from-env';
    expect(resolveLinearApiKey(project)).toEqual({
      apiKey: 'from-env',
      source: 'env',
    });
  });

  it('falls back to the global key when the env var is blank', () => {
    writeCredential('linear', { apiKey: 'from-global' });
    process.env.LINEAR_API_KEY = '   ';
    expect(resolveLinearApiKey(project)).toEqual({
      apiKey: 'from-global',
      source: 'global',
    });
  });

  it('does not leak one project key into another project', () => {
    writeProjectCredential('/tmp/dispatch-project-b', 'linear', {
      apiKey: 'b-key',
    });
    expect(resolveLinearApiKey(project)).toEqual({
      apiKey: null,
      source: null,
    });
  });

  it('trims a stored key and ignores a blank one', () => {
    writeProjectCredential(project, 'linear', { apiKey: '  spaced-key  ' });
    expect(resolveLinearApiKey(project).apiKey).toBe('spaced-key');

    writeProjectCredential(project, 'linear', { apiKey: '   ' });
    writeCredential('linear', { apiKey: 'from-global' });
    expect(resolveLinearApiKey(project)).toEqual({
      apiKey: 'from-global',
      source: 'global',
    });
  });

  it('treats a corrupt file as no credentials rather than throwing', () => {
    mkdirSync(join(fakeHome, '.dispatch'), { recursive: true });
    writeFileSync(credentialsPath(), '{ not json');
    expect(resolveLinearApiKey(project)).toEqual({
      apiKey: null,
      source: null,
    });
  });
});
