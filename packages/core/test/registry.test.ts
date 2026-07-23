import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import {
  readRegistry,
  registryPath,
  upsertRegisteredProject,
} from '../src/registry.js';

let fakeHome: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-registry-home-'));
  process.env.DISPATCH_HOME = fakeHome;
});

afterEach(() => {
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
});

describe('registryPath', () => {
  it('points at $DISPATCH_HOME/.dispatch/projects.json', () => {
    expect(registryPath()).toBe(join(fakeHome, '.dispatch', 'projects.json'));
  });
});

describe('readRegistry', () => {
  it('returns [] when the file is missing', () => {
    expect(readRegistry()).toEqual([]);
  });

  it('returns [] when the file has corrupt JSON', () => {
    const path = registryPath();
    mkdirSync(join(fakeHome, '.dispatch'), { recursive: true });
    writeFileSync(path, '{ not json');
    expect(readRegistry()).toEqual([]);
  });
});

describe('upsertRegisteredProject', () => {
  it('creates the file with name = basename and ISO stamps', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'dispatch-project-'));
    const entry = upsertRegisteredProject(projectDir);

    expect(entry.path).toBe(projectDir);
    expect(entry.name).toBe(basename(projectDir));
    expect(() => new Date(entry.addedAt).toISOString()).not.toThrow();
    expect(new Date(entry.addedAt).toISOString()).toBe(entry.addedAt);
    expect(new Date(entry.lastOpenedAt).toISOString()).toBe(entry.lastOpenedAt);

    const all = readRegistry();
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(entry);
  });

  it('dedupes a second upsert of the same path, even with a trailing slash', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'dispatch-project-'));
    const first = upsertRegisteredProject(projectDir);

    // Ensure the ISO timestamps actually differ between the two upserts.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const second = upsertRegisteredProject(`${projectDir}/`);

    const all = readRegistry();
    expect(all).toHaveLength(1);
    expect(all[0].path).toBe(projectDir);
    expect(all[0].addedAt).toBe(first.addedAt);
    expect(all[0].lastOpenedAt).toBe(second.lastOpenedAt);
    expect(second.lastOpenedAt >= first.lastOpenedAt).toBe(true);
  });

  it('rewrites a corrupt registry file cleanly', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'dispatch-project-'));
    const path = registryPath();
    // Directly write invalid JSON to simulate a corrupted registry file —
    // readRegistry() should treat this as empty, and upsert should replace it
    // with a valid single-entry file rather than erroring or appending.
    mkdirSync(join(fakeHome, '.dispatch'), { recursive: true });
    writeFileSync(path, '{ this is not valid json');

    expect(readRegistry()).toEqual([]);

    const entry = upsertRegisteredProject(projectDir);
    const all = readRegistry();
    expect(all).toEqual([entry]);
    expect(JSON.parse(readFileSync(path, 'utf8')).projects).toEqual([entry]);
  });
});
