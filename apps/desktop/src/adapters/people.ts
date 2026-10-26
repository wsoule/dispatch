import type { ActorKind, Assignee, Person } from '@dispatch-foo/core/browser';
import type { PersonChoice, UiTone } from '@dispatch/ui';

import { assigneeLabel, assigneeRef } from '../lib/taskDisplay';

// Dispatch's people registry and executors → @dispatch/ui's AssigneePicker
// choices, and an assignee wire value → the words a cell prints for it. Pure
// functions over plain data (no React): a picker option's mark may be a React
// node, so an agent's glyph is attached by the view, keyed off `kind` here.

/** The legacy agent pool: a task any agent of the fan-out may pick up. */
export const AGENT_POOL: Assignee = 'agent';
/** How the pool reads in a picker and a cell (`assigneeLabel` says "Agent",
 * which beside named agents would read as one of them). */
export const AGENT_POOL_LABEL = 'Any agent';
/** The picker group the pool and the executors are listed under. */
export const AGENTS_GROUP = 'Agents';

/**
 * One assignee choice: a PersonChoice (what AssigneePicker takes) plus which
 * kind of actor it names, so the view can give agents their own glyph
 * (`mark: { kind: 'node', node }`) and leave humans the initials avatar set
 * here. Structurally a PersonChoice, so the array is handed to the picker as
 * is.
 */
export interface AssigneeChoice extends PersonChoice {
  kind: ActorKind;
}

export interface PersonChoicesInput {
  /** The project's people registry (`DispatchProjectData.people`). A
   * placeholder (an unresolved Linear user) is never offered. */
  people: readonly Person[];
  /** The daemon's executors (`ExecutorsResponse.executors`, or their names). */
  executors: readonly (string | { name: string })[];
  /** This window's own `human:<handle>` ref, or null until the daemon says. */
  me: string | null;
}

/** The handle inside an actor ref (`human:wyat` → `wyat`), or the raw value
 * when it is not a ref. */
function handleOf(ref: string): string {
  const colon = ref.indexOf(':');
  return colon === -1 ? ref : ref.slice(colon + 1);
}

/**
 * The assignee ref a dispatch for `me` writes for a run on `executor`:
 * `agent:<my handle>/<executor>` (an agent is owned by the human it works
 * for, see core's ActorRef), or `agent:<executor>` while nobody is signed in.
 */
export function agentChoiceId(me: string | null, executor: string): string {
  return me === null
    ? `agent:${executor}`
    : `agent:${handleOf(me)}/${executor}`;
}

/**
 * The assignee picker's choices: the people (you first, then registry order;
 * each with the handle as its hint, the email and handle as search words and
 * the initials avatar as its mark), then an "Agents" group holding the pool
 * ("Any agent") and one choice per executor. Without a registry the one human
 * on offer is you (or the legacy bare `human` while nobody is signed in), so a
 * project with no `people:` can still hand work to a person, as the old
 * control did with its three fixed kinds.
 */
export function buildPersonChoices(
  input: PersonChoicesInput
): AssigneeChoice[] {
  const humans: AssigneeChoice[] = [];
  for (const person of input.people) {
    if (person.placeholder === true) continue;
    const handle = handleOf(person.ref);
    const keywords = [person.email, handle].filter(
      (word): word is string => typeof word === 'string' && word !== ''
    );
    const choice: AssigneeChoice = {
      id: person.ref,
      name: person.name,
      hint: handle,
      keywords,
      mark: { kind: 'avatar', name: person.name },
      kind: 'human',
    };
    if (person.ref === input.me) humans.unshift(choice);
    else humans.push(choice);
  }
  if (humans.length === 0) {
    const id = input.me ?? 'human';
    const name = input.me === null ? assigneeLabel('human') : handleOf(id);
    humans.push({
      id,
      name,
      mark: { kind: 'avatar', name },
      kind: 'human',
    });
  }
  const agents: AssigneeChoice[] = [
    {
      id: AGENT_POOL,
      name: AGENT_POOL_LABEL,
      group: AGENTS_GROUP,
      kind: 'agent',
    },
  ];
  for (const executor of input.executors) {
    const name = typeof executor === 'string' ? executor : executor.name;
    const id = agentChoiceId(input.me, name);
    agents.push({
      id,
      name,
      keywords: [id],
      group: AGENTS_GROUP,
      kind: 'agent',
    });
  }
  return [...humans, ...agents];
}

export interface AssigneeDisplay {
  /** The name a cell prints: the registered person's name, else the handle;
   * "Any agent" for the pool; "Unassigned" for nobody. */
  label: string;
  /** `muted` for nobody; otherwise the cell's own voice. */
  tone?: UiTone;
  isAgent: boolean;
}

/**
 * The words for an assignee wire value, with `assigneeLabel`'s reading of a
 * ref (a named ref by its handle, a malformed one as a person with the raw
 * value for a handle, a missing one as unassigned), except that a registered
 * person is named by the registry and the bare pool reads "Any agent".
 */
export function assigneeDisplay(
  assignee: Assignee | null | undefined,
  personFor: (assignee: string) => { name: string } | undefined
): AssigneeDisplay {
  const ref = assigneeRef(assignee);
  if (ref === null) {
    return { label: assigneeLabel(assignee), tone: 'muted', isAgent: false };
  }
  if (ref.kind === 'agent') {
    return {
      label: ref.handle === null ? AGENT_POOL_LABEL : assigneeLabel(assignee),
      isAgent: true,
    };
  }
  // `assignee` is a string here: a null or empty value has no ref.
  const person =
    assignee === null || assignee === undefined
      ? undefined
      : personFor(assignee);
  return { label: person?.name ?? assigneeLabel(assignee), isAgent: false };
}
