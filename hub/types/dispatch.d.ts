// The Dispatch app's mod declarations, copied from the app folder it writes them into.
// Written by dispatch-app on every start: the `dispatch` module mods import.
// gpui-kit.d.ts has the elements and styles; AGENTS.md says how to write a mod.
declare module 'dispatch' {
  /** Any JSON value, as the core sends it. */
  export type Json =
    | null
    | boolean
    | number
    | string
    | Json[]
    | { [key: string]: Json };
  type Obj = { [key: string]: Json };

  /** A registered project. */
  export interface Project {
    id: string;
    name: string;
    path: string;
    addedAtMs: number;
    [key: string]: Json;
  }
  /** Anything doing work on this machine, or a teammate's session in a shared
   * project (`remote: true`, with its `machine` and `device`; it has no terminal
   * and only its own core can act on it). `state` is one of the core's words
   * (working, blocked, done, idle, error, stalled, ended) or null; tolerate others. */
  export interface Session {
    id: string;
    address: string;
    kind: string;
    client: string | null;
    label: string | null;
    terminal: string | null;
    cwd: string | null;
    state: string | null;
    waitingOn: string | null;
    status: Obj | null;
    startedAtMs: number;
    endedAtMs: number | null;
    [key: string]: Json;
  }
  /** A terminal the core holds. */
  export interface Terminal {
    id: string;
    name: string | null;
    argv: string[];
    cwd: string;
    state: string;
    status: Obj | null;
    [key: string]: Json;
  }
  /** A task: its fields by name (title, status, priority, …), each field's rev, and its records. */
  export interface Task {
    project: string;
    id: string;
    fields: Obj;
    revs: { [field: string]: number };
    records: Obj[];
    pending: boolean;
  }
  /** A run of an agent on a task. */
  export interface Run {
    id: string;
    project: string;
    task: string;
    agent: string;
    state: string;
    costUsd: number;
    turns: number;
    [key: string]: Json;
  }
  /** A line of the Overseer conversation. `role` is `user` (the person), `assistant`
   * (the Overseer), `report` (a flag: something the core reported, in fixed words)
   * or `notice` (what came of an action or answer); tolerate others. */
  export interface OverseerLine {
    n: number;
    role: string;
    text: string;
    delivered: boolean;
    atMs: number;
    [key: string]: Json;
  }
  /** Something waiting on the person. `kind` is gate, question, review, failed or
   * departure; `todo` says what to do; each of `choices` answers it with
   * `overseer.answer {item, choice}` (a question's `reply` takes a `body`). */
  export interface NeedsYou {
    item: string;
    kind: string;
    project: string | null;
    task: string | null;
    run: string | null;
    gateType: string | null;
    todo: string;
    choices: string[];
    method: string;
    atMs: number;
    [key: string]: Json;
  }
  /** The Overseer as its person sees it. `conversation` is the open one (the latest
   * not ended; `state` idle, thinking or ended) or null; `items` is what waits on
   * the person; `willing` whether the Overseer is on; `leads` who leads each
   * project (`lead.core` is a machine id; `machine` is this core's). */
  export interface Overseer {
    conversation: Obj | null;
    lines: OverseerLine[];
    items: NeedsYou[];
    willing: boolean | null;
    leads: Obj[];
    machine: string | null;
  }
  /** Where the app stands with its core: state is looking, starting, connected, missing or down. */
  export interface Core {
    state: string;
    seq: number;
    [key: string]: Json;
  }
  /** The theme: colours by role (tokens), each tone's colours, the tone of
   * every status word, the type scale in points (`small`, `body`, `title`,
   * `heading`), radii (`control`, `panel`), the spacing grid, the fonts in use,
   * and whether to keep still. `appearance` is `dark` or `light`. */
  export interface Theme {
    name: string;
    appearance: string;
    tokens: { [name: string]: string };
    tones: {
      [tone: string]: { tone: string; ink: string; soft: string; line: string };
    };
    status: { [word: string]: string };
    text: {
      small: number;
      body: number;
      title: number;
      heading: number;
      [name: string]: number;
    };
    radius: { control: number; panel: number; [name: string]: number };
    space: number;
    fonts: { ui: string; mono: string };
    reduceMotion: boolean;
  }

  /** Registered projects. */
  export function projects(): Project[];
  /** Sessions, optionally only those in one state. */
  export function sessions(filter?: { state?: string }): Session[];
  /** Terminals the core holds. */
  export function terminals(): Terminal[];
  /** Tasks, optionally of one project, status or parent. */
  export function tasks(filter?: {
    project?: string;
    status?: string;
    parent?: string;
  }): Task[];
  /** One task with its records, or null. */
  export function task(project: string, id: string): Task | null;
  /** Runs, optionally of one project or task. */
  export function runs(filter?: { project?: string; task?: string }): Run[];
  /** Claims: which holder is working on which task. */
  export function claims(): Obj[];
  /** Docs, channels and memory, as the snapshot lists them. */
  export function list(name: 'docs' | 'channels' | 'memory'): Obj[];
  /** The latest events, oldest first, whatever their type. */
  export function recent(): Obj[];
  /** The Overseer: its open conversation, what waits on the person, who leads. */
  export function overseer(): Overseer;
  /** Where the app stands with its core. */
  export function core(): Core;
  /** The app itself: `home` is the app folder (where `mods/`, `themes/` and
   * `AGENTS.md` are), `layout` the layout in use, `shown` every mod on screen
   * now (a sidebar marks the view it shows), `person` who is at the window
   * (their login name, or empty). */
  export function app(): {
    home: string;
    layout: string;
    shown: string[];
    person: string;
  };
  /** A run's log, live: `entries` (each `{n, kind, text, phase, atMs}`; kinds
   * `system`, `assistant`, `tool`, `result`, `approval`, `usage`, `error`,
   * `review`, `verify`, `merge`), or null until it has been read. Asking
   * follows the run: new entries arrive as the core writes them. */
  export function runLog(run: string): { run: string; entries: Obj[] | null };
  /** What a mod was asked to show, by `panel.show` or a command such as `task.open`. */
  export function args(mod: string): Obj;
  /** The theme in force: colours by role, tones, the status map, the type
   * scale (`text`), `radius`, `space`, the fonts in use and `reduceMotion`. */
  export function theme(): Theme;
  /** The person's settings, merged over the shipped ones. */
  export function settings(): Obj;
  /** A size in points at the person's zoom. Use it for every size you draw. */
  export function px(points: number): number;
  /** Runs a command by name: the app's own or any core method (`dispatch-app commands`).
   * Throws when the name or the arguments are wrong; runs after the current call returns. */
  export function run(command: string, args?: Obj): null;
  /** Calls a core method and resolves with its answer; rejects with the core's error. */
  export function call(method: string, params?: Obj): Promise<Json>;
  /** A terminal the core holds, attached and typed into. `terminal` is its id;
   * null shows nothing. The element fills its place. */
  export const Terminal: {
    new: (
      id: string,
      props: { terminal: string | null }
    ) => import('gpui-kit').NativeElement;
  };
  /** Marks the element it is placed in (filling it, drawing nothing) so that
   * `dispatch-app click <id>` clicks the middle of that element, as a person would. */
  export const Mark: {
    new: (id: string, props?: Obj) => import('gpui-kit').NativeElement;
  };
  /** Where the `Mark` with this id was last drawn, in window pixels, or null
   * before it has been: what a mod that pans and zooms its own canvas fits to. */
  export function markBounds(
    id: string
  ): { x: number; y: number; width: number; height: number } | null;
}
