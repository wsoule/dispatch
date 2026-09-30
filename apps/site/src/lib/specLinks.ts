import { fileURLToPath } from 'node:url';

import type { HastPlugin } from './satteriPlugin';

const SPEC_FILE =
  /^(?:\.\/)?(?:([0-9]{2})-[a-z0-9-]+|appendix-([a-f])-[a-z0-9-]+)\.md(#s[0-9A-F.]+)?$/;
const VERSION_PATH = /[/\\]versions[/\\]([^/\\]+)[/\\]spec[/\\][^/\\]+\.md$/;

// The site URL of a link to another spec file; a link with no fragment goes
// to that file's first section. Null for every other href.
export function specHref(href: string, version: string): string | null {
  const m = SPEC_FILE.exec(href);
  if (m === null) return null;
  const first =
    m[1] !== undefined
      ? `#s${Number(m[1])}`
      : `#s${(m[2] ?? '').toUpperCase()}`;
  return `/protocol/${version}/${m[3] ?? first}`;
}

// The frozen version a rendered file belongs to (versions/<v>/spec/…).
export function versionOfPath(path: string | undefined): string | null {
  return path === undefined ? null : (VERSION_PATH.exec(path)?.[1] ?? null);
}

// The DMP text links between its files as `03-addresses.md#s3.4`; the site has
// one page per version, so a frozen file's links go to /protocol/<v>/#s3.4.
export function specLinks(): HastPlugin {
  return {
    name: 'dmp-spec-links',
    element: {
      filter: ['a'],
      visit(node, ctx) {
        const href = node.properties['href'];
        if (typeof href !== 'string' || ctx.fileURL === undefined) return;
        const version = versionOfPath(fileURLToPath(ctx.fileURL));
        const next = version === null ? null : specHref(href, version);
        if (next !== null) ctx.setProperty(node, 'href', next);
      },
    },
  };
}
