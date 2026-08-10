import type { ReactNode } from 'react';

// A titled group of rows in the rail (Properties, Labels, Blocked by) — the
// small muted header that lets Linear stack several property groups down the
// sidebar without any dividers doing the separating.
export function RailSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="text-muted-foreground/70 px-2 pb-1 text-[11px] font-medium tracking-wide">
        {title}
      </div>
      {children}
    </div>
  );
}
