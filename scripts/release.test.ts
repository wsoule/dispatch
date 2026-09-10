import { describe, expect, test } from 'bun:test';

import {
  bumpVersionField,
  compareVersions,
  parseArgs,
  parseVersion,
  readVersionField,
  releaseSubject,
  renderCommitMessage,
  VERSION_FILES,
} from './release';

describe('parseVersion', () => {
  test('accepts strict X.Y.Z', () => {
    expect(parseVersion('0.26.0')).toEqual([0, 26, 0]);
    expect(parseVersion('12.0.3')).toEqual([12, 0, 3]);
  });

  test('rejects prefixes, suffixes, and short forms', () => {
    expect(parseVersion('v0.26.0')).toBeNull();
    expect(parseVersion('0.26')).toBeNull();
    expect(parseVersion('0.26.0-rc.1')).toBeNull();
    expect(parseVersion('01.2.3')).toBeNull();
    expect(parseVersion('')).toBeNull();
  });
});

describe('compareVersions', () => {
  test('rejects an equal version', () => {
    expect(compareVersions('0.26.0', '0.26.0')).toBe(0);
  });

  test('rejects a lower version on every component', () => {
    expect(compareVersions('0.25.9', '0.26.0')).toBeLessThan(0);
    expect(compareVersions('0.26.0', '0.26.1')).toBeLessThan(0);
    expect(compareVersions('0.99.99', '1.0.0')).toBeLessThan(0);
  });

  test('accepts a higher version on every component', () => {
    expect(compareVersions('0.26.1', '0.26.0')).toBeGreaterThan(0);
    expect(compareVersions('0.27.0', '0.26.5')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0);
  });

  // The whole reason this is numeric: "0.10.0" < "0.9.0" as strings.
  test('handles two-digit components numerically', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('0.9.0', '0.10.0')).toBeLessThan(0);
    expect(compareVersions('0.26.10', '0.26.9')).toBeGreaterThan(0);
  });

  test('throws on input that is not a version', () => {
    expect(() => compareVersions('v0.27.0', '0.26.0')).toThrow(/not a version/);
    expect(() => compareVersions('0.27.0', 'latest')).toThrow(/not a version/);
  });
});

// One fixture per real file shape: tauri.conf.json puts "version" after two
// other keys, the package.json files after "name". Every byte outside the
// version string must survive the rewrite.
const tauriConf = `{
  "$schema": "../node_modules/@tauri-apps/cli/config.schema.json",
  "productName": "Dispatch",
  "version": "0.26.0",
  "identifier": "dev.dispatch.app",
  "bundle": {
    "resources": ["resources/dispatchd"]
  }
}
`;

const packageJson = `{
  "name": "@dispatch/cli",
  "version": "0.26.0",
  "private": true,
  "license": "MIT",
  "dependencies": {
    "@dispatch/core": "workspace:*"
  }
}
`;

const tabIndented = `{\n\t"name": "x",\n\t"version": "0.26.0",\n\t"engines": { "version": "keep" }\n}\n`;

describe('readVersionField / bumpVersionField', () => {
  test('reads the top-level version out of each shape', () => {
    expect(readVersionField(tauriConf)).toBe('0.26.0');
    expect(readVersionField(packageJson)).toBe('0.26.0');
    expect(readVersionField(tabIndented)).toBe('0.26.0');
    expect(readVersionField('{ "name": "x" }')).toBeNull();
  });

  test('bumps the three fixtures and preserves everything else', () => {
    for (const fixture of [tauriConf, packageJson, tabIndented]) {
      const bumped = bumpVersionField(fixture, '0.27.0');
      expect(readVersionField(bumped)).toBe('0.27.0');
      // Reverting the single change gives back the input byte-for-byte:
      // indentation, key order, trailing newline all intact.
      expect(bumped.replace('"version": "0.27.0"', '"version": "0.26.0"')).toBe(
        fixture
      );
      expect(bumped.endsWith('\n')).toBe(true);
    }
  });

  test('leaves a nested "version" key alone', () => {
    const bumped = bumpVersionField(tabIndented, '0.27.0');
    expect(bumped).toContain('"engines": { "version": "keep" }');
  });

  test('throws when there is no version field to rewrite', () => {
    expect(() => bumpVersionField('{ "name": "x" }\n', '0.27.0')).toThrow(
      /no top-level "version"/
    );
  });

  test('the three-file rule names exactly the release-bearing files', () => {
    expect([...VERSION_FILES]).toEqual([
      'apps/desktop/src-tauri/tauri.conf.json',
      'apps/desktop/package.json',
      'packages/cli/package.json',
    ]);
  });
});

describe('commit message', () => {
  test('subject uses the chore(release) form with an em dash', () => {
    expect(releaseSubject('0.27.0', 'the summary')).toBe(
      'chore(release): v0.27.0 — the summary'
    );
  });

  test('subject only when there is no body and no trailers', () => {
    expect(renderCommitMessage('0.27.0', 'the summary')).toBe(
      'chore(release): v0.27.0 — the summary\n'
    );
  });

  test('body and trailers land in their own paragraphs', () => {
    const message = renderCommitMessage('0.27.0', 'the summary', {
      body: 'Line one of the body.\nLine two.',
      trailers: [
        'Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>',
        'Claude-Session: https://claude.ai/code/session_x',
      ],
    });
    expect(message).toBe(
      [
        'chore(release): v0.27.0 — the summary',
        '',
        'Line one of the body.',
        'Line two.',
        '',
        'Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>',
        'Claude-Session: https://claude.ai/code/session_x',
        '',
      ].join('\n')
    );
  });

  test('trailers without a body still sit in a separate paragraph', () => {
    const message = renderCommitMessage('0.27.0', 's', {
      trailers: ['Co-Authored-By: A <a@example.com>'],
    });
    expect(message).toBe(
      'chore(release): v0.27.0 — s\n\nCo-Authored-By: A <a@example.com>\n'
    );
  });
});

describe('parseArgs', () => {
  test('reads version, summary, and the flags', () => {
    expect(
      parseArgs([
        '0.27.0',
        'the summary',
        '--dry-run',
        '--trailer',
        'Co-Authored-By: A <a@example.com>',
        '--body',
        'why',
      ])
    ).toEqual({
      version: '0.27.0',
      summary: 'the summary',
      dryRun: true,
      body: 'why',
      trailers: ['Co-Authored-By: A <a@example.com>'],
    });
  });

  test('rejects a v-prefixed version, a missing summary, and unknown flags', () => {
    expect(() => parseArgs(['v0.27.0', 's'])).toThrow(/no "v" prefix/);
    expect(() => parseArgs(['0.27.0'])).toThrow(/usage/);
    expect(() => parseArgs(['0.27.0', 's', '--force'])).toThrow(/unknown flag/);
    expect(() => parseArgs(['0.27.0', 'two\nlines'])).toThrow(/single/);
  });
});
