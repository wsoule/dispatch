import type { ApiClient } from '@dispatch/client';

type CreateInput = Parameters<ApiClient['createTask']>[0];

// Starting work from the phone: what a typed note becomes as a task, and what
// a `dispatch-remote://task/new` link may put in the New task form.

/** Longest title the phone writes; the rest of a long first line goes to the
 *  description, so nothing typed is lost. */
const TITLE_MAX = 120;

/** Most text a link may put in the form. A link is a URL someone else can
 *  craft, so it fills in a draft to read, never a whole document. */
const LINK_TEXT_MAX = 4000;

type TaskFromText =
  | { ok: true; input: CreateInput }
  | { ok: false; error: string };

/**
 * A task out of what was typed on the New task screen. The first line is the
 * title and everything after it the description, the way a note or a commit
 * message reads. A first line longer than a title is cut at a word and kept
 * whole at the top of the description.
 */
export function taskFromText(text: string): TaskFromText {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const first = lines.findIndex((line) => line.trim() !== '');
  if (first === -1)
    return { ok: false, error: 'Write what the task is first.' };
  // A note app's heading or bullet is not part of the title.
  const head = lines[first]!.trim().replace(/^(#+|[-*•])\s+/, '');
  const rest = lines
    .slice(first + 1)
    .join('\n')
    .trim();
  const title = shorten(head);
  const description = [title === head ? '' : head, rest]
    .filter((part) => part !== '')
    .join('\n\n');
  return {
    ok: true,
    input: description === '' ? { title } : { title, description },
  };
}

function shorten(line: string): string {
  if (line.length <= TITLE_MAX) return line;
  const cut = line.slice(0, TITLE_MAX - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > TITLE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * The New task form's starting text from a link's params, as expo-router
 * hands them over (already decoded). An iOS Shortcut on the share sheet sends
 * `title` and `url` for a Safari page, or `text` for anything else. The page
 * title becomes the first line and its address the description.
 */
export function draftFromParams(
  params: Partial<Record<string, string | string[]>>
): string {
  const one = (name: string) => {
    const value = params[name];
    return typeof value === 'string' ? value.trim() : '';
  };
  const parts = [one('title'), one('text'), one('url')].filter(
    (part, i, all) => part !== '' && all.indexOf(part) === i
  );
  return parts.join('\n\n').slice(0, LINK_TEXT_MAX);
}
