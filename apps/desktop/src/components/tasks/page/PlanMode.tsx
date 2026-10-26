import { ContainerFlightPlanSection } from '../../flightplan/ContainerFlightPlanSection';
import type { TaskPageModel } from './pageModel';
import { useTaskPageHost } from './TaskPageHost';

/**
 * Plan mode — a container's Flight Plan as the main pane: its children as waves, live.
 * On the Tasks page a node quick-looks in the slide-over; a host that says
 * `planOpensPages`, or a page embedded in another view (the Overseer's column), opens a
 * node as its own page instead.
 */
export function PlanMode({ page }: { page: TaskPageModel }) {
  const opensPages = useTaskPageHost()?.planOpensPages === true;
  const peeks = !page.embedded && !opensPages;
  return (
    <div
      data-slot="plan-mode"
      className="shadow-hairline-top flex min-h-0 flex-1 flex-col"
    >
      <ContainerFlightPlanSection
        containerId={page.item.meta.id}
        openIn={peeks ? 'peek' : 'page'}
        focusOnMount={!page.embedded}
      />
    </div>
  );
}
