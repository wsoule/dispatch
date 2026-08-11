import type { ReactNode } from 'react';

// A titled block in the main column (Description, Acceptance Criteria,
// Sessions, Activity) — a quiet header plus its content, separated from
// neighbors by whitespace rather than the heavy top-borders the old
// single-column layout stacked on every section.
export function MainSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}
