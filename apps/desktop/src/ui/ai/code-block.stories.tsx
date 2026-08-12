import { CodeBlock } from './code-block';
import type { GalleryStory } from '@/views/galleryStories';

// A small, real-looking merge-queue helper — enough surface to exercise every ts
// token kind the tokenizer covers: a line comment, keywords, a string, and a number.
const MERGE_QUEUE_SAMPLE = `// Origin-first: re-test a queued diff against main before landing it.
export function nextInQueue(queue: MergeCandidate[]): MergeCandidate | null {
  const ready = queue.filter((candidate) => candidate.checksPassed);
  if (ready.length === 0) return null;
  return ready[0];
}

const MAX_RETRIES = 3;`;

// A short boot-retry patch, revealed line by line to demo the streaming reveal.
const BOOT_RETRY_SAMPLE = `// Retry a boot once before surfacing force-fail to the queue.
async function bootWithRetry(taskId: string, attempt = 1): Promise<void> {
  try {
    await bootSandbox(taskId);
  } catch (error) {
    if (attempt >= MAX_RETRIES) throw error;
    await bootWithRetry(taskId, attempt + 1);
  }
}`;

const CONFIG_SAMPLE = `{
  "taskId": "t-cafe27",
  "streaming": true,
  "maxRetries": 3,
  "queue": null
}`;

/** Task 22's gallery stories, kept in this file rather than `galleryStories.tsx` per
 * the parallel-wave convention — the integration step folds these into the shared
 * catalog once every sibling primitive has landed. */
export const codeBlockStories: GalleryStory[] = [
  {
    id: 'code-block-static',
    title: 'Code block — static',
    note: 'Full source rendered at once: mono filename, language label, and a copy button that swaps to a check mark and "Copied" for 1.5s.',
    render: () => (
      <CodeBlock
        code={MERGE_QUEUE_SAMPLE}
        language="ts"
        filename="mergeQueue.ts"
      />
    ),
  },
  {
    id: 'code-block-streaming',
    title: 'Code block — streaming',
    note: 'Reveals line by line as an agent writes it — each completed line fades in (instantly under reduced motion) rather than flickering mid-word.',
    render: () => (
      <CodeBlock
        code={BOOT_RETRY_SAMPLE}
        language="ts"
        filename="bootRetry.ts"
        streaming
      />
    ),
  },
  {
    id: 'code-block-json-no-filename',
    title: 'Code block — JSON, no filename',
    note: 'Filename is optional — the header falls back to just the language label. Also exercises the JSON tokenizer (string keys, keyword literals, numbers).',
    render: () => <CodeBlock code={CONFIG_SAMPLE} language="json" />,
  },
];
