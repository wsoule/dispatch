import { defineConfig } from 'astro/config';

import { markdownProcessor } from './src/lib/markdown.ts';

// No `site` is configured: Base.astro writes the one canonical link, for the
// protocol alias pages, on dispatch.foo itself.
export default defineConfig({ markdown: { processor: markdownProcessor() } });
