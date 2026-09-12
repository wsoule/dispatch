import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sidecarExecutableName } from './build-sidecars';

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('sidecarExecutableName', () => {
  test('adds .exe to every Windows sidecar and leaves Unix names unchanged', () => {
    const names = ['dispatchd', 'dispatch-mcp', 'dispatch-cli'];
    expect(names.map((name) => sidecarExecutableName(name, 'win32'))).toEqual([
      'dispatchd.exe',
      'dispatch-mcp.exe',
      'dispatch-cli.exe',
    ]);
    expect(names.map((name) => sidecarExecutableName(name, 'linux'))).toEqual(
      names
    );
    expect(names.map((name) => sidecarExecutableName(name, 'darwin'))).toEqual(
      names
    );
  });
});

test('Tauri keeps Unix resources in the base config and overrides them on Windows', () => {
  const base = JSON.parse(
    readFileSync(resolve(desktopDir, 'src-tauri', 'tauri.conf.json'), 'utf8')
  ) as { bundle: { resources: string[] } };
  const windows = JSON.parse(
    readFileSync(
      resolve(desktopDir, 'src-tauri', 'tauri.windows.conf.json'),
      'utf8'
    )
  ) as { bundle: { resources: string[] } };

  expect(base.bundle.resources).toEqual([
    'resources/dispatchd',
    'resources/dispatch-mcp',
    'resources/dispatch-cli',
  ]);
  expect(windows.bundle.resources).toEqual([
    'resources/dispatchd.exe',
    'resources/dispatch-mcp.exe',
    'resources/dispatch-cli.exe',
  ]);
});

test('desktop:tauri-dev depends on the cacheable sidecar build outputs', () => {
  const moon = readFileSync(resolve(desktopDir, 'moon.yml'), 'utf8');
  const sidecarTask = moon.match(
    /  build-sidecars:\n([\s\S]*?)\n  tauri-dev:/
  )?.[1];
  const tauriDevTask = moon.match(/  tauri-dev:\n([\s\S]*?)\n  # deps/)?.[1];

  expect(sidecarTask).toContain("- 'src-tauri/resources/dispatchd*'");
  expect(sidecarTask).toContain("- '$RUNNER_ARCH'");
  expect(sidecarTask).not.toContain('cache: false');
  expect(tauriDevTask).toContain("- 'build-sidecars'");
});
