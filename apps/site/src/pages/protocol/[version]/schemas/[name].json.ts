import type { APIRoute } from 'astro';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { readManifest, VERSIONS_DIR } from '../../../../lib/protocolSource';

// Each frozen version's JSON Schemas at /protocol/<version>/schemas/<file>,
// served byte for byte as the manifest hashed them.
export function getStaticPaths() {
  const manifest = readManifest();
  return Object.entries(manifest.versions).flatMap(([version, { files }]) =>
    Object.keys(files)
      .filter((file) => /^schemas\/[^/]+\.schema\.json$/.test(file))
      .map((file) => ({
        params: {
          version,
          name: file.slice('schemas/'.length, -'.json'.length),
        },
      }))
  );
}

export const GET: APIRoute = ({ params }) => {
  const file = resolve(
    VERSIONS_DIR,
    params.version ?? '',
    'schemas',
    `${params.name ?? ''}.json`
  );
  return new Response(readFileSync(file), {
    headers: { 'content-type': 'application/schema+json' },
  });
};
