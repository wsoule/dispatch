import type { OverseerMessage } from './api';

// The structured view of an Overseer action that creates or changes tasks,
// shared by the desktop chat and the TUI. An action carries only its tool name,
// its validated input and (once applied) the ids it touched; this module turns
// that into what a card shows: the milestone, one row per task with its
// priority, blockers and dependency wave, and the real ids once they exist.
// Live status is not here — each surface looks the ids up in its own task list.

/** The tools whose actions render as a card rather than a summary line. */
export const OVERSEER_CARD_TOOLS = [
  'create_plan',
  'create_task',
  'update_task',
  'dispatch_task',
] as const;
export type OverseerCardTool = (typeof OVERSEER_CARD_TOOLS)[number];

/** Where an action card is in its life. */
export type OverseerCardState = 'proposed' | 'applied' | 'denied' | 'failed';

/** One task on a card. */
export interface OverseerCardRow {
  /** The real task id: known for existing tasks, and for new ones once applied. */
  id?: string;
  /** What the input named it; null when it names an existing task by id only. */
  title: string | null;
  priority?: string;
  description?: string;
  /** Blockers as the card shows them: `#n` for this plan's own n-th task until
   *  it has an id, otherwise task ids. */
  blockedBy: string[];
  /** 1 for tasks that wait on nothing in this card; n+1 after a wave-n blocker. */
  wave: number;
}

/** A field change an update_task proposes. */
export interface OverseerCardChange {
  field: 'title' | 'status' | 'priority' | 'blockers';
  to: string;
}

export interface OverseerCard {
  tool: OverseerCardTool;
  /** create_plan's new milestone, with its id once applied. */
  milestone?: {
    title: string;
    description?: string;
    /** A project the milestone files under. */
    parent?: string;
    id?: string;
  };
  /** The existing milestone or parent task the rows file under. */
  parent?: string;
  rows: OverseerCardRow[];
  /** update_task's changes; empty for every other tool. */
  changes: OverseerCardChange[];
  /** A plan with a new milestone starts its agents on approval unless told not to. */
  sends: boolean;
}

const PLAN_REF = /^#(\d+)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];
}

/** True for the tools `overseerCard` knows how to read. */
export function isOverseerCardTool(tool: string): tool is OverseerCardTool {
  return (OVERSEER_CARD_TOOLS as readonly string[]).includes(tool);
}

// A plan's rows with their waves: a row's wave is one past its latest
// plan-local blocker's, so rows in one wave can start together. Blockers on
// existing tasks don't move the wave — the card cannot know when they land.
function planRows(tasks: unknown[]): OverseerCardRow[] {
  const rows: OverseerCardRow[] = [];
  for (const raw of tasks) {
    const task = isRecord(raw) ? raw : {};
    const blockedBy = strings(task.blockedBy);
    let wave = 1;
    for (const ref of blockedBy) {
      const local = PLAN_REF.exec(ref);
      const blocker = local === null ? undefined : rows[Number(local[1]) - 1];
      if (blocker !== undefined) wave = Math.max(wave, blocker.wave + 1);
    }
    const priority = str(task.priority);
    const description = str(task.description);
    rows.push({
      title: str(task.title) ?? null,
      ...(priority !== undefined ? { priority } : {}),
      ...(description !== undefined ? { description } : {}),
      blockedBy,
      wave,
    });
  }
  return rows;
}

// A plan once applied: each row gets its id, and `#n` blockers become the ids
// they resolved to. `entities` is [milestone?, ...tasks] in input order; a
// count that doesn't match (an older daemon, a partial write) leaves the
// preview as it was rather than pinning ids to the wrong rows.
function withPlanIds(card: OverseerCard, entities: string[]): OverseerCard {
  const offset = card.milestone === undefined ? 0 : 1;
  if (entities.length !== card.rows.length + offset) return card;
  const ids = entities.slice(offset);
  return {
    ...card,
    ...(card.milestone !== undefined
      ? { milestone: { ...card.milestone, id: entities[0] } }
      : {}),
    rows: card.rows.map((row, i) => ({
      ...row,
      id: ids[i],
      blockedBy: row.blockedBy.map((ref) => {
        const local = PLAN_REF.exec(ref);
        return local === null ? ref : (ids[Number(local[1]) - 1] ?? ref);
      }),
    })),
  };
}

/**
 * The card for one action, or null when the tool is not a task tool or its
 * input is not a shape this build reads. `entities` is what the applied action
 * reported touching.
 */
export function overseerCard(
  tool: string,
  input: unknown,
  entities?: readonly string[]
): OverseerCard | null {
  if (!isOverseerCardTool(tool) || !isRecord(input)) return null;
  const ids = entities === undefined ? [] : [...entities];
  const parent = str(input.parent);
  const base = { tool, changes: [], sends: false, rows: [] } as OverseerCard;

  switch (tool) {
    case 'create_plan': {
      if (!Array.isArray(input.tasks)) return null;
      const milestone = isRecord(input.milestone) ? input.milestone : null;
      const milestoneTitle = str(milestone?.title);
      const card: OverseerCard = {
        ...base,
        ...(milestone !== null && milestoneTitle !== undefined
          ? {
              milestone: {
                title: milestoneTitle,
                ...(str(milestone.description) !== undefined
                  ? { description: str(milestone.description) }
                  : {}),
                ...(str(milestone.parent) !== undefined
                  ? { parent: str(milestone.parent) }
                  : {}),
              },
            }
          : {}),
        ...(parent !== undefined ? { parent } : {}),
        rows: planRows(input.tasks),
        sends: milestone !== null && input.send !== false,
      };
      return ids.length > 0 ? withPlanIds(card, ids) : card;
    }
    case 'create_task': {
      const [row] = planRows([input]);
      return {
        ...base,
        ...(parent !== undefined ? { parent } : {}),
        rows: [{ ...row, ...(ids[0] !== undefined ? { id: ids[0] } : {}) }],
      };
    }
    case 'update_task': {
      const taskId = str(input.taskId);
      if (taskId === undefined) return null;
      const changes: OverseerCardChange[] = [];
      const title = str(input.title);
      if (title !== undefined) changes.push({ field: 'title', to: title });
      const status = str(input.status);
      if (status !== undefined) changes.push({ field: 'status', to: status });
      const priority = str(input.priority);
      if (priority !== undefined) {
        changes.push({ field: 'priority', to: priority });
      }
      if (Array.isArray(input.blockedBy)) {
        const blockers = strings(input.blockedBy);
        changes.push({
          field: 'blockers',
          to: blockers.length === 0 ? 'none' : blockers.join(', '),
        });
      }
      return {
        ...base,
        rows: [{ id: taskId, title: title ?? null, blockedBy: [], wave: 1 }],
        changes,
      };
    }
    case 'dispatch_task': {
      const taskId = str(input.taskId);
      if (taskId === undefined) return null;
      return {
        ...base,
        rows: [{ id: taskId, title: null, blockedBy: [], wave: 1 }],
      };
    }
  }
}

/** Every real id a card names — its milestone and rows — for a live status lookup. */
export function overseerCardIds(card: OverseerCard): string[] {
  const ids = card.rows.flatMap((row) =>
    row.id === undefined ? [] : [row.id]
  );
  return card.milestone?.id === undefined ? ids : [card.milestone.id, ...ids];
}

/** The highest wave on a card; above 1 means the rows start in order, not all at once. */
export function overseerCardWaves(card: OverseerCard): number {
  return card.rows.reduce((most, row) => Math.max(most, row.wave), 0);
}

/**
 * Each action's input, by action id, from the transcript's queued rows. The
 * record keeps an action's input only while it is pending; this is how a
 * decided action's card still shows what was proposed.
 */
export function overseerActionInputs(
  messages: readonly OverseerMessage[]
): Map<string, unknown> {
  const inputs = new Map<string, unknown>();
  for (const message of messages) {
    if (
      message.role === 'action' &&
      message.actionId !== undefined &&
      message.input !== undefined &&
      !inputs.has(message.actionId)
    ) {
      inputs.set(message.actionId, message.input);
    }
  }
  return inputs;
}
