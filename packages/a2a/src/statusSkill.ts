import type { JsonValue } from '@dispatch/protocol';

// One of the caller's handoffs, as the status skill reports it.
export interface StatusEntry {
  a2aTask: string;
  task: string;
  title: string;
  status: string;
  stage?: 'review' | 'landing';
  pr?: string;
}

function entryLine(e: StatusEntry): string {
  const status = e.stage === undefined ? e.status : `${e.status} (${e.stage})`;
  return [e.task, status, e.title, ...(e.pr === undefined ? [] : [e.pr])].join(
    ' · '
  );
}

// The status skill's direct reply: one text line per handoff and the same
// entries as data.
export function statusReply(entries: readonly StatusEntry[]): {
  text: string;
  data: JsonValue;
} {
  const text =
    entries.length === 0
      ? 'No handoffs yet.'
      : entries.map(entryLine).join('\n');
  const tasks: JsonValue[] = entries.map((e) => ({
    a2aTask: e.a2aTask,
    task: e.task,
    title: e.title,
    status: e.status,
    ...(e.stage === undefined ? {} : { stage: e.stage }),
    ...(e.pr === undefined ? {} : { pr: e.pr }),
  }));
  return { text, data: { tasks } };
}
