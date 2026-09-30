import {
  Banknote,
  BookOpen,
  Box,
  Briefcase,
  Bug,
  Calendar,
  ChartColumn,
  CircleDot,
  Cloud,
  Code,
  Compass,
  Database,
  Diamond,
  Flag,
  Globe,
  Heart,
  KeyRound,
  Lightbulb,
  ListChecks,
  Lock,
  type LucideIcon,
  Megaphone,
  Plane,
  Puzzle,
  Rocket,
  Server,
  Settings,
  Shield,
  Smartphone,
  Star,
  Target,
  Terminal,
  Trophy,
  Users,
  Wrench,
} from 'lucide-react';

import { containerIconSource } from '../../../lib/containerIcon';
import { cn } from '@/lib/utils';

const KIND_ICON: Record<string, LucideIcon> = {
  initiative: Target,
  project: Box,
  milestone: Diamond,
  task: CircleDot,
};

/** A kind's own glyph: a target for an initiative, a box for a project, and so on. */
export function kindIcon(kind: string): LucideIcon {
  return KIND_ICON[kind] ?? CircleDot;
}

// Linear's common project icon names, lowercased, onto the nearest lucide glyph.
const NAMED_ICON: Record<string, LucideIcon> = {
  airplane: Plane,
  book: BookOpen,
  briefcase: Briefcase,
  bug: Bug,
  calendar: Calendar,
  chart: ChartColumn,
  checklist: ListChecks,
  cloud: Cloud,
  code: Code,
  compass: Compass,
  cube: Box,
  database: Database,
  flag: Flag,
  gear: Settings,
  globe: Globe,
  heart: Heart,
  key: KeyRound,
  lightbulb: Lightbulb,
  lock: Lock,
  megaphone: Megaphone,
  mobile: Smartphone,
  money: Banknote,
  people: Users,
  puzzle: Puzzle,
  rocket: Rocket,
  server: Server,
  shield: Shield,
  star: Star,
  target: Target,
  terminal: Terminal,
  tools: Wrench,
  trophy: Trophy,
  users: Users,
};

/** A container's glyph: its own icon (an emoji, or a Linear icon name the app knows) in its
 * own colour, else its kind's glyph. */
export function ContainerIcon({
  kind,
  icon,
  color,
  className,
}: {
  kind: string;
  icon: string | null;
  color: string | null;
  className?: string;
}) {
  const source = containerIconSource(icon);
  if (source?.kind === 'emoji') {
    return (
      <span
        aria-hidden
        data-slot="container-icon"
        className={cn(
          'inline-flex size-3.5 shrink-0 items-center justify-center text-[12px] leading-none',
          className
        )}
      >
        {source.emoji}
      </span>
    );
  }
  const Icon =
    (source === null ? undefined : NAMED_ICON[source.name]) ?? kindIcon(kind);
  return (
    <Icon
      aria-hidden
      data-slot="container-icon"
      className={cn('text-muted-foreground', className)}
      style={color === null ? undefined : { color }}
    />
  );
}
