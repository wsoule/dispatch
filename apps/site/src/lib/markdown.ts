import { satteri } from '@astrojs/markdown-satteri';

import { sectionIds } from './sectionIds';
import { specLinks } from './specLinks';

// The site's markdown processor. Markdown here is only the DMP text:
// sectionIds gives numbered headings their #s<number> anchors, specLinks
// points NN-name.md#sX links at them, and smart punctuation stays off so
// quoted literal values render as written.
export function markdownProcessor(): ReturnType<typeof satteri> {
  return satteri({
    features: { smartPunctuation: false },
    hastPlugins: [sectionIds(), specLinks()],
  });
}
