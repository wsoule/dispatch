import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { LinearPanel } from './LinearPanel';
import { SectionLabel } from '@/ui/chrome';

/** Third-party trackers this project can sync with. Linear is the first; a second
 *  integration slots in here as another panel beside it. */
export function IntegrationsSection({ data }: { data: DispatchProjectData }) {
  return (
    <section className="flex flex-col gap-3">
      <SectionLabel>Integrations</SectionLabel>
      <LinearPanel data={data} />
    </section>
  );
}
