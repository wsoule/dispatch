import { fileURLToPath } from 'node:url';

import { startTeamService } from './server.js';

// The production entry for the dispatch-team service: config from the
// environment, a clean stop on SIGTERM (Railway sends it before a redeploy).

const env = process.env;
const origin = (
  env.PUBLIC_URL ?? `http://localhost:${env.PORT ?? '8080'}`
).replace(/\/+$/, '');
const service = startTeamService({
  port: Number(env.PORT ?? '8080'),
  hostname: env.HOSTNAME_BIND ?? '0.0.0.0',
  dataDir: env.DATA_DIR ?? './data',
  origin,
  githubClientId: env.GITHUB_CLIENT_ID ?? null,
  githubClientSecret: env.GITHUB_CLIENT_SECRET ?? null,
  linearClientId: env.LINEAR_CLIENT_ID ?? null,
  desktopDistDir:
    env.DESKTOP_DIST_DIR ??
    fileURLToPath(new URL('../../desktop/dist/', import.meta.url)),
  devLogin: env.DEV_LOGIN === '1' && !origin.startsWith('https://'),
  teamSecret: env.TEAM_SECRET ?? null,
});
console.log(
  JSON.stringify({
    level: 'info',
    event: 'team.started',
    port: service.port,
    origin,
  })
);

const stop = (): void => {
  void service.stop().then(() => process.exit(0));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
