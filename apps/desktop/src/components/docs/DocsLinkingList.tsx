import type { ApiClient } from '@dispatch/client';
import { ChipButton } from '@dispatch/ui';

import { useDocsLinking } from '../../hooks/useDocs';
import styles from './DocsLinkingList.module.css';

interface DocsLinkingListProps {
  client: ApiClient | null;
  port: number | undefined;
  /** `thread:<root id>`, `memory:<entry id>` and the like. */
  target: string;
  onOpenDoc: (id: string) => void;
}

/** The docs that link one target, each a chip button that opens it, in a
 *  region named "Linked docs" (a landmark, as before the restyle) holding
 *  their list; nothing when none does. The route answers only docs the
 *  caller may see. */
export function DocsLinkingList({
  client,
  port,
  target,
  onOpenDoc,
}: DocsLinkingListProps) {
  const { docs } = useDocsLinking(client, port, target);
  if (docs.length === 0) return null;
  return (
    <section aria-label="Linked docs" className={styles.strip}>
      <span className={styles.label} aria-hidden="true">
        Docs
      </span>
      <ul className={styles.list}>
        {docs.map((d) => (
          <li key={d.doc.id}>
            <ChipButton onClick={() => onOpenDoc(d.doc.id)}>
              {d.doc.title}
              <span className={styles.rel}>{d.rel}</span>
            </ChipButton>
          </li>
        ))}
      </ul>
    </section>
  );
}
