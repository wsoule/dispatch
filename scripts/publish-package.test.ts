import { describe, expect, it } from 'bun:test';

import {
  checkPackedManifest,
  checkPackedTypes,
  distTagFor,
  resolvePackage,
  smokeInstallArgs,
  stripScripts,
} from './publish-package.ts';
import type { PackageJson } from './publish-package.ts';

// A packed manifest as pnpm writes it: workspace:* already an exact version.
const good: PackageJson = {
  name: '@dispatch-foo/protocol',
  version: '0.2.0',
  license: 'MIT',
  repository: {
    url: 'git+https://github.com/wsoule/dispatch.git',
    directory: 'packages/protocol',
  },
  publishConfig: { access: 'public' },
  scripts: {
    build: 'tsdown --clean',
    prepublishOnly: 'moon run protocol:prepublish',
  },
  dependencies: { '@dispatch-foo/core': '0.24.0' },
};

describe('checkPackedManifest', () => {
  it('accepts exact versions of the published scope', () => {
    expect(checkPackedManifest(good)).toEqual([]);
  });
  it('refuses workspace: and catalog: specs anywhere', () => {
    const problems = checkPackedManifest({
      ...good,
      dependencies: { '@dispatch-foo/core': 'workspace:*' },
      devDependencies: { tsdown: 'catalog:' },
    });
    expect(problems.join('\n')).toContain('workspace:');
    expect(problems.join('\n')).toContain('catalog:');
  });
  it('refuses a range on the published scope and any @dispatch/ dependency', () => {
    expect(
      checkPackedManifest({
        ...good,
        dependencies: { '@dispatch-foo/core': '^0.24.0' },
      })
    ).toHaveLength(1);
    expect(
      checkPackedManifest({
        ...good,
        dependencies: { '@dispatch/core': '0.24.0' },
      })
    ).toHaveLength(1);
  });
  it('refuses a private manifest, a missing public access and a foreign repository', () => {
    const bad = {
      ...good,
      private: true,
      publishConfig: {},
      repository: { url: 'git+https://example.com/x.git' },
    };
    expect(checkPackedManifest(bad)).toHaveLength(3);
  });
  it('accepts the ELv2 federation package', () => {
    const federation = {
      ...good,
      name: '@dispatch-foo/federation',
      license: 'Elastic-2.0',
      repository: {
        url: good.repository?.url,
        directory: 'packages/federation',
      },
    };
    expect(checkPackedManifest(federation)).toEqual([]);
  });
});

it('strips lifecycle scripts from the staged manifest', () => {
  expect(stripScripts(good).scripts).toBeUndefined();
});

describe('resolvePackage', () => {
  const read = (dir: string): PackageJson => ({
    ...good,
    name: `@dispatch-foo/${dir.split('/')[1] ?? ''}`,
    version: '0.2.0',
  });
  it('maps a package tag to its directory and checks the version', () => {
    expect(resolvePackage('protocol@0.2.0', read)).toEqual({
      project: 'protocol',
      dir: 'packages/protocol',
      name: '@dispatch-foo/protocol',
      version: '0.2.0',
    });
    expect(() => resolvePackage('protocol@0.3.0', read)).toThrow('version');
  });
  it('resolves a bare project name for the dry run', () => {
    expect(resolvePackage('protocol-spec', read).dir).toBe(
      'packages/protocol-spec'
    );
  });
  it('refuses the desktop tags and unknown packages', () => {
    expect(() => resolvePackage('v0.33.0', read)).toThrow('not a package tag');
    expect(() => resolvePackage('server@1.0.0', read)).toThrow(
      'not publishable'
    );
  });
});

it('puts drafts on latest until a stable release exists, then on next', () => {
  expect(distTagFor('1.0.0-draft.2', ['0.0.0', '1.0.0-draft.1'])).toBe(
    'latest'
  );
  expect(distTagFor('1.1.0-draft.1', ['0.0.0', '1.0.0'])).toBe('next');
  expect(distTagFor('1.0.1', ['0.0.0', '1.0.0'])).toBe('latest');
});

describe('checkPackedTypes', () => {
  it('accepts a .d.ts that imports only runtime dependencies', () => {
    const dts = [
      {
        path: 'dist/index.d.ts',
        text: "import { SqliteDatabase } from '@dispatch-foo/core';\nexport type X = SqliteDatabase;\n",
      },
    ];
    expect(checkPackedTypes(good, dts)).toEqual([]);
  });
  it('refuses a .d.ts that imports a devDependency-only workspace package', () => {
    const dts = [
      {
        path: 'dist/conformance.d.ts',
        text: "import type { Hello } from '@dispatch-foo/protocol-spec';\nexport declare const H: Hello;\n",
      },
    ];
    const withDev = {
      ...good,
      devDependencies: { '@dispatch-foo/protocol-spec': 'workspace:*' },
    };
    expect(checkPackedTypes(withDev, dts).join('\n')).toContain(
      'dist/conformance.d.ts imports @dispatch-foo/protocol-spec'
    );
  });
  it('catches import("…") types and old @dispatch/ specifiers too', () => {
    const dts = [
      {
        path: 'dist/a.d.ts',
        text: "export type Y = import('@dispatch/core/graph').Z;\n",
      },
    ];
    expect(checkPackedTypes(good, dts)).toHaveLength(1);
  });
});

describe('smokeInstallArgs', () => {
  it('installs each packed dependency under its own name, then the package', () => {
    expect(
      smokeInstallArgs(good, '/out/package.tgz', {
        '@dispatch-foo/core': '/deps/c.tgz',
      })
    ).toEqual([
      'install',
      '--no-audit',
      '--no-fund',
      '@dispatch-foo/core@file:/deps/c.tgz',
      '/out/package.tgz',
    ]);
  });
  it('leaves a dependency with no local tarball to the registry (the stage job)', () => {
    expect(smokeInstallArgs(good, '/out/package.tgz', {})).toEqual([
      'install',
      '--no-audit',
      '--no-fund',
      '/out/package.tgz',
    ]);
  });
});
