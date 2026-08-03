import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkMergeDriverSetup,
  checkTeamMergeDriverSetup,
  GITATTRIBUTES_LINE,
  mergeGitAttributes,
  registerMergeDriverGitConfig,
  registerTeamMergeDriverGitConfig,
  TEAM_GITATTRIBUTES_LINE,
  writeGitAttributes,
} from '../src/mergeDriver.js';

describe('mergeGitAttributes', () => {
  it('creates a fresh file with just the driver line when none exists', () => {
    expect(mergeGitAttributes(undefined)).toBe(`${GITATTRIBUTES_LINE}\n`);
  });

  it('appends to existing content, preserving it', () => {
    const out = mergeGitAttributes('*.png binary\n');
    expect(out).toBe(`*.png binary\n${GITATTRIBUTES_LINE}\n`);
  });

  it('does not duplicate the line if it is already present', () => {
    const once = mergeGitAttributes(undefined);
    expect(mergeGitAttributes(once)).toBe(once);
  });

  it('does not duplicate the line among other content', () => {
    const existing = `*.png binary\n${GITATTRIBUTES_LINE}\n*.jpg binary\n`;
    expect(mergeGitAttributes(existing)).toBe(existing);
  });

  it('ends with a trailing newline even without one on input', () => {
    const out = mergeGitAttributes('*.png binary');
    expect(out.endsWith('\n')).toBe(true);
    expect(out).toBe(`*.png binary\n${GITATTRIBUTES_LINE}\n`);
  });
});

// These exercise the filesystem/git-config side against a real temp git
// repo — checkMergeDriverSetup shells out to `git config`, so it needs one.
describe('writeGitAttributes / registerMergeDriverGitConfig / checkMergeDriverSetup', () => {
  function initRepo(): string {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-merge-driver-'));
    spawnSync('git', ['init', '-q'], { cwd: root });
    return root;
  }

  it('reports both missing before setup runs', () => {
    const root = initRepo();
    expect(checkMergeDriverSetup(root)).toEqual({
      gitattributes: false,
      gitConfig: false,
    });
  });

  it('reports both present after writeGitAttributes + registerMergeDriverGitConfig', () => {
    const root = initRepo();
    writeGitAttributes(root);
    registerMergeDriverGitConfig(root);
    expect(checkMergeDriverSetup(root)).toEqual({
      gitattributes: true,
      gitConfig: true,
    });
    // writeGitAttributes writes both drivers' lines in one pass.
    expect(readFileSync(join(root, '.gitattributes'), 'utf8')).toBe(
      `${GITATTRIBUTES_LINE}\n${TEAM_GITATTRIBUTES_LINE}\n`
    );
  });

  it('flags gitConfig missing on its own — the fresh-clone case', () => {
    // A fresh clone gets the committed .gitattributes but never ran
    // `dispatch init` locally, so only the git config half is missing.
    const root = initRepo();
    writeGitAttributes(root);
    expect(checkMergeDriverSetup(root)).toEqual({
      gitattributes: true,
      gitConfig: false,
    });
  });
});

// Mirrors the task-driver suite above — same contract, different driver name.
describe('team-roster merge driver registration', () => {
  function initRepo(): string {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-merge-driver-'));
    spawnSync('git', ['init', '-q'], { cwd: root });
    return root;
  }

  it('reports both missing before setup runs', () => {
    const root = initRepo();
    expect(checkTeamMergeDriverSetup(root)).toEqual({
      gitattributes: false,
      gitConfig: false,
    });
  });

  it('reports both present after writeGitAttributes + registerTeamMergeDriverGitConfig', () => {
    const root = initRepo();
    writeGitAttributes(root);
    registerTeamMergeDriverGitConfig(root);
    expect(checkTeamMergeDriverSetup(root)).toEqual({
      gitattributes: true,
      gitConfig: true,
    });
  });

  it('flags gitConfig missing on its own — the fresh-clone case', () => {
    const root = initRepo();
    writeGitAttributes(root);
    expect(checkTeamMergeDriverSetup(root)).toEqual({
      gitattributes: true,
      gitConfig: false,
    });
  });

  it('registering the team driver does not affect the task driver, and vice versa', () => {
    const root = initRepo();
    writeGitAttributes(root);
    registerMergeDriverGitConfig(root);
    expect(checkTeamMergeDriverSetup(root)).toEqual({
      gitattributes: true,
      gitConfig: false,
    });
    registerTeamMergeDriverGitConfig(root);
    expect(checkMergeDriverSetup(root)).toEqual({
      gitattributes: true,
      gitConfig: true,
    });
    expect(checkTeamMergeDriverSetup(root)).toEqual({
      gitattributes: true,
      gitConfig: true,
    });
  });
});
