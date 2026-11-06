// "Copy as Mermaid" for the Tasks graph: plain text a README, a PR or Linear renders.

function nodeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_]/g, '_');
}

function label(text: string): string {
  return `"${text.replace(/"/g, '#quot;')}"`;
}

/** The milestone map: one node per milestone, an edge per counted wait. */
export function milestonesToMermaid(
  nodes: readonly { id: string; title: string; done: number; total: number }[],
  edges: readonly { from: string; to: string; count: number }[]
): string {
  const lines = ['flowchart LR'];
  for (const node of nodes) {
    lines.push(
      `  ${nodeId(node.id)}[${label(`${node.title}<br/>${node.done}/${node.total} landed`)}]`
    );
  }
  for (const edge of edges) {
    lines.push(`  ${nodeId(edge.from)} -->|${edge.count}| ${nodeId(edge.to)}`);
  }
  return lines.join('\n');
}

/** Every task in its milestone's subgraph, with every wait among the shown tasks. */
export function tasksToMermaid(
  milestones: readonly {
    id: string;
    title: string;
    tasks: readonly {
      id: string;
      title: string;
      blockedBy: readonly string[];
    }[];
  }[]
): string {
  const lines = ['flowchart LR'];
  const shown = new Set(milestones.flatMap((m) => m.tasks.map((t) => t.id)));
  for (const milestone of milestones) {
    lines.push(`  subgraph ${nodeId(milestone.id)}[${label(milestone.title)}]`);
    for (const task of milestone.tasks) {
      lines.push(
        `    ${nodeId(task.id)}[${label(`${task.id} ${task.title}`)}]`
      );
    }
    lines.push('  end');
  }
  for (const milestone of milestones) {
    for (const task of milestone.tasks) {
      for (const blocker of task.blockedBy) {
        if (!shown.has(blocker)) continue;
        lines.push(`  ${nodeId(blocker)} --> ${nodeId(task.id)}`);
      }
    }
  }
  return lines.join('\n');
}
