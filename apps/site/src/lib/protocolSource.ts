import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The build runs in apps/site (moon's project cwd); only frozen versions render.
export const VERSIONS_DIR = resolve(
  process.cwd(),
  '../../packages/protocol-spec/versions'
);
export const EXTENSIONS = {
  envelope: '8.4',
  gate: '8.5',
  work: '8.6',
} as const;
export type ExtensionName = keyof typeof EXTENSIONS;

export interface VersionsManifest {
  versions: Record<string, { date: string; files: Record<string, string> }>;
  aliases: Record<string, string>;
  extensions: Record<string, string>;
}

export function readManifest(): VersionsManifest {
  return JSON.parse(
    readFileSync(resolve(VERSIONS_DIR, 'manifest.json'), 'utf8')
  ) as VersionsManifest;
}

// §8.3 plus one extension's subsection of a frozen §8, as markdown: each
// extension URI serves exactly that. A missing section fails the build.
export function extensionMarkdown(
  version: string,
  name: ExtensionName
): string {
  const binding = readFileSync(
    resolve(VERSIONS_DIR, version, 'spec/08-a2a-binding.md'),
    'utf8'
  );
  const parts = binding.split(/^(?=## )/m);
  const pick = (n: string): string => {
    const part = parts.find((p) => p.startsWith(`## ${n} `));
    if (part === undefined)
      throw new Error(`DMP ${version} §8 has no ${n} section`);
    return part;
  };
  return `${pick('8.3')}\n${pick(EXTENSIONS[name])}`;
}
