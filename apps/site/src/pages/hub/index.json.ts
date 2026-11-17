import type { APIRoute } from 'astro';

import { HUB_VERSION, hubMods } from '../../data/hub';

// /hub/index.json: the mod hub's listing, which the app reads to browse and
// install mods. Every field is spelled out so the order stays fixed.
export const GET: APIRoute = () =>
  new Response(
    `${JSON.stringify(
      {
        version: HUB_VERSION,
        mods: hubMods.map((m) => ({
          id: m.id,
          name: m.name,
          kind: m.kind,
          summary: m.summary,
          author: m.author,
          repo: m.repo,
          commit: m.commit,
          path: m.path,
          added: m.added,
        })),
      },
      null,
      2
    )}\n`,
    { headers: { 'content-type': 'application/json; charset=utf-8' } }
  );
