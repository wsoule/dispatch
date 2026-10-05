import { ContainerFlightPlanSection } from '../../flightplan/ContainerFlightPlanSection';
import type { TaskPageModel } from './pageModel';

/**
 * Plan mode — a container's Flight Plan as the main pane: its children as waves, live.
 * On the full page a node opens in a pane beside the plan; a split pane or peek has no
 * room for one, so there a node opens its own page.
 */
export function PlanMode({ page }: { page: TaskPageModel }) {
  const full = page.layout === 'full';
  return (
    <div
      data-slot="plan-mode"
      className="shadow-hairline-top flex min-h-0 flex-1 flex-col"
    >
      <ContainerFlightPlanSection
        containerId={page.item.meta.id}
        openIn={full ? 'pane' : 'page'}
        focusOnMount={full}
      />
    </div>
  );
}
