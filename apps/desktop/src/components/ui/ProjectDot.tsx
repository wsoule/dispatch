import { colorForProject } from '../../lib/projectColor';
import './ProjectDot.css';

interface ProjectDotProps {
  projectId: string;
}

/** Small color chip identifying which project a session/card/row belongs to — see
 * `colorForProject` for how the color is picked. */
export function ProjectDot({ projectId }: ProjectDotProps) {
  return (
    <span
      className="project-dot"
      style={{ backgroundColor: colorForProject(projectId) }}
      aria-hidden="true"
    />
  );
}
