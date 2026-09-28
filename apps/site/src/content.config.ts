import { glob } from 'astro/loaders';
import { defineCollection } from 'astro:content';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  extensionMarkdown,
  EXTENSIONS,
  readManifest,
  VERSIONS_DIR,
} from './lib/protocolSource';
import type { ExtensionName } from './lib/protocolSource';

// Every frozen version's sections; unreleased edits in spec/ never render.
const protocol = defineCollection({
  loader: glob({
    pattern: '*/spec/*.md',
    base: VERSIONS_DIR,
    generateId: ({ entry }) => entry.replace(/\.md$/, ''),
  }),
});

// The three extension pages, each rendered from the version the manifest names.
const protocolExtensions = defineCollection({
  loader: {
    name: 'protocol-extensions',
    load: async ({ store, renderMarkdown }) => {
      store.clear();
      const manifest = readManifest();
      for (const name of Object.keys(EXTENSIONS) as ExtensionName[]) {
        const version = manifest.extensions[name];
        if (version === undefined) continue;
        const body = extensionMarkdown(version, name);
        // The file URL tells specLinks which frozen version this text is from.
        const fileURL = pathToFileURL(
          resolve(VERSIONS_DIR, version, 'spec/08-a2a-binding.md')
        );
        store.set({
          id: name,
          data: { name, version },
          body,
          rendered: await renderMarkdown(body, { fileURL }),
        });
      }
    },
  },
});

export const collections = { protocol, protocolExtensions };
