import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Run transcripts and actor identity live under $DISPATCH_HOME keyed by a hash
// of the project root, so the two clones never share run history.
export function runKey(rootDir: string): string {
  return createHash('sha256').update(rootDir).digest('hex').slice(0, 12);
}

export interface DemoActor {
  handle: string;
  email: string;
  displayName: string;
}

export const ACTORS: DemoActor[] = [
  {
    handle: 'wsoule679',
    email: 'wsoule679@gmail.com',
    displayName: 'Wyat Soule',
  },
  {
    handle: 'pmirand',
    email: 'p.miranda@example.com',
    displayName: 'Priya Miranda',
  },
  {
    handle: 'dokafor',
    email: 'd.okafor@example.com',
    displayName: 'Dami Okafor',
  },
];

/** The human who drives the demo; the other actors only ever appear via the puppet. */
export const OWNER = ACTORS[0];
export const TEAMMATE = ACTORS[1];

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const ignore = join(repoRoot, '.agents', 'ignore');

export const DEMO = {
  repoRoot,
  ignore,
  /** Source of the storefront codebase, copied into the clone on generate. */
  template: join(repoRoot, 'packages', 'demo', 'storefront-src'),
  root: join(ignore, 'storefront'),
  home: join(ignore, 'storefront-home'),
  teammateRoot: join(ignore, 'teammate', 'storefront'),
  teammateHome: join(ignore, 'teammate', 'home'),
  remote: 'git@github.com:wsoule/storefront.git',
} as const;

/** Where a clone's run transcripts live, given its root and DISPATCH_HOME. */
export function runsDir(rootDir: string, home: string): string {
  return join(home, '.dispatch', 'runs', runKey(rootDir));
}

/** Where a clone's actor identity file lives. */
export function actorFile(rootDir: string, home: string): string {
  return join(home, '.dispatch', 'actor', `${runKey(rootDir)}.json`);
}
