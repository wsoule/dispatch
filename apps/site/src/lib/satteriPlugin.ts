import type { SatteriProcessorOptions } from '@astrojs/markdown-satteri';

// A hast plugin for Sätteri, Astro's markdown processor: the plugin object its
// `hastPlugins` option takes (entries may also be factories, arrays or null).
export type HastPlugin = Extract<
  NonNullable<SatteriProcessorOptions['hastPlugins']>[number],
  { name: string }
>;
