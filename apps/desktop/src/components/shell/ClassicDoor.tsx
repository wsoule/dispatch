import type { ClassicOnlyView } from '../../lib/twoViews';
import { Button } from '@/ui/button';
import { EmptyState } from '@/ui/chrome';

const LABEL: Record<ClassicOnlyView, string> = {
  threads: 'Threads',
  branches: 'Git',
  files: 'Files',
  terminals: 'Terminals',
  design: 'Design',
  impact: 'Impact',
  plans: 'Plans',
  'brain-dump': 'Notes',
};

/** A screen with no Two views home yet: say so, and offer the classic layout. */
export function ClassicDoor({
  view,
  onOpenClassic,
  onBack,
}: {
  view: ClassicOnlyView;
  onOpenClassic: () => void;
  onBack: () => void;
}) {
  return (
    <EmptyState
      className="h-full"
      heading={`${LABEL[view]} lives in the classic layout for now.`}
      description="Two views is in beta. Switching turns the beta off; turn it back on in Settings › General."
      action={
        <div className="flex gap-2">
          <Button size="sm" onClick={onOpenClassic}>
            Open {LABEL[view]} in classic layout
          </Button>
          <Button size="sm" variant="ghost" onClick={onBack}>
            Back to tasks
          </Button>
        </div>
      }
    />
  );
}
