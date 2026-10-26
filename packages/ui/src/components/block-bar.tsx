import type { ReactNode } from 'react';

/* A section's heading row (Gr8r's section title: semibold 14.5px, a quiet
   meta on the right), using the global .blockBar classes. Sections are not
   numbered: `index` is still accepted so old callers compile, but it is
   never rendered; callers drop it as they migrate. */
export interface BlockBarProps {
  /** @deprecated Ignored: sections are no longer numbered. */
  index?: string;
  title: string;
  /** Right-aligned quiet note: dates, counts, sync time. */
  meta?: ReactNode;
  /** Extra controls placed before the meta. */
  children?: ReactNode;
}

export default function BlockBar({
  title,
  meta,
  children,
}: BlockBarProps): ReactNode {
  return (
    <div className="blockBar">
      <h2 className="blockTitle">{title}</h2>
      {children}
      {meta !== undefined && meta !== null ? (
        <span className="blockMeta">{meta}</span>
      ) : null}
    </div>
  );
}
