import type { ApiClient } from '@dispatch/client';

import { useDocsLinking } from '../../hooks/useDocs';

interface DocsLinkingListProps {
  client: ApiClient | null;
  port: number | undefined;
  /** `thread:<root id>`, `memory:<entry id>` and the like. */
  target: string;
  onOpenDoc: (id: string) => void;
}

/** The docs that link one target, each a button that opens it; nothing when
 *  none does. The route answers only docs the caller may see. */
export function DocsLinkingList({
  client,
  port,
  target,
  onOpenDoc,
}: DocsLinkingListProps) {
  const { docs } = useDocsLinking(client, port, target);
  if (docs.length === 0) return null;
  return (
    <section
      aria-label="Linked docs"
      className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] px-3 py-1.5 text-xs"
    >
      <span className="text-[var(--color-muted-foreground)]">Docs</span>
      {docs.map((d) => (
        <button
          key={d.doc.id}
          type="button"
          className="rounded px-1 hover:bg-[var(--color-muted)]"
          onClick={() => onOpenDoc(d.doc.id)}
        >
          {d.doc.title}
          <span className="ml-1 text-[var(--color-muted-foreground)]">
            {d.rel}
          </span>
        </button>
      ))}
    </section>
  );
}
