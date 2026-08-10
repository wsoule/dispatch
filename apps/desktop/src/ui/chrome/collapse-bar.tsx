import { ChevronDown, ChevronUp } from 'lucide-react';

import { cn } from '@/lib/utils';

/** The quiet bar standing in for hidden rows — "16 unmodified lines", "+2 more". */
export function CollapseBar({
  label,
  collapsed,
  onToggle,
  className,
}: {
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  className?: string;
}) {
  const Icon = collapsed ? ChevronDown : ChevronUp;
  return (
    <button
      type="button"
      aria-expanded={!collapsed}
      onClick={onToggle}
      className={cn(
        'bg-muted hover:bg-secondary dense-meta flex w-full items-center gap-2 rounded px-3 py-1.5',
        'transition-colors duration-150',
        className
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      <span>{label}</span>
    </button>
  );
}
