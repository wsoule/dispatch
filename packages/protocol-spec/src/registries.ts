import { readFileSync } from 'node:fs';

export const REGISTRY_NAMES = [
  'address-schemes',
  'address-characters',
  'envelope-fields',
  'kinds',
  'ref-types',
  'gate-types',
  'system-markers',
  'delivery-states',
  'error-codes',
  'extension-uris',
] as const;
export type RegistryName = (typeof REGISTRY_NAMES)[number];

const STATUSES = [
  'permanent',
  'provisional',
  'appendix',
  'informative',
  'reserved',
] as const;
export type EntryStatus = (typeof STATUSES)[number];

const SCOPES = [
  'core',
  'dispatch',
  'a2a',
  'memory',
  'docs',
  'federation',
] as const;
export type EntryScope = (typeof SCOPES)[number];

const RAISERS = ['system', 'system-or-decider', 'session'] as const;
export type GateRaiser = (typeof RAISERS)[number];

export interface RegistryEntry {
  value: string;
  scope: EntryScope;
  status: EntryStatus;
  since: string;
  section: string;
  reference?: string;
  vectors: string[];
  note?: string;
  // gate-types only
  raisedBy?: GateRaiser;
  choices?: string[];
  data?: Record<string, string>;
  effect?: string;
  // delivery-states only: MAY be hidden from a host's external API
  internal?: boolean;
  // error-codes only
  httpStatus?: number;
}

export type Registry = Record<RegistryName, RegistryEntry[]>;

export const REGISTRY_PATH = new URL(
  '../registries/registries.json',
  import.meta.url
);

// Registries whose values the engine exports, so the drift rule applies.
export const ENGINE_REGISTRIES: readonly RegistryName[] = [
  'address-schemes',
  'kinds',
  'ref-types',
  'gate-types',
  'system-markers',
  'delivery-states',
  'error-codes',
];

const COMMON_FIELDS = [
  'value',
  'scope',
  'status',
  'since',
  'section',
  'reference',
  'vectors',
  'note',
];
const EXTRA_FIELDS: Partial<Record<RegistryName, readonly string[]>> = {
  'gate-types': ['raisedBy', 'choices', 'data', 'effect'],
  'delivery-states': ['internal'],
  'error-codes': ['httpStatus'],
};

function isString(v: unknown): v is string {
  return typeof v === 'string' && v !== '';
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === 'string');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Why one registry entry is malformed, or null when it is well formed.
function entryProblem(name: RegistryName, e: unknown): string | null {
  if (!isRecord(e)) return 'is not an object';
  const known = [...COMMON_FIELDS, ...(EXTRA_FIELDS[name] ?? [])];
  const unknown = Object.keys(e).find((k) => !known.includes(k));
  if (unknown !== undefined) return `has unknown field ${unknown}`;
  if (!isString(e['value'])) return 'value must be a non-empty string';
  if (!(SCOPES as readonly unknown[]).includes(e['scope']))
    return `scope must be one of ${SCOPES.join(', ')}`;
  if (!(STATUSES as readonly unknown[]).includes(e['status']))
    return `status must be one of ${STATUSES.join(', ')}`;
  if (!isString(e['since'])) return 'since must be a non-empty string';
  if (!isString(e['section'])) return 'section must be a non-empty string';
  if (!isStringArray(e['vectors'])) return 'vectors must be a string array';
  for (const key of ['reference', 'note', 'effect']) {
    if (e[key] !== undefined && !isString(e[key]))
      return `${key} must be a non-empty string`;
  }
  if (
    e['raisedBy'] !== undefined &&
    !(RAISERS as readonly unknown[]).includes(e['raisedBy'])
  )
    return `raisedBy must be one of ${RAISERS.join(', ')}`;
  if (e['choices'] !== undefined && !isStringArray(e['choices']))
    return 'choices must be a string array';
  const data = e['data'];
  if (
    data !== undefined &&
    !(isRecord(data) && Object.values(data).every((v) => isString(v)))
  )
    return 'data must map field names to descriptions';
  if (e['internal'] !== undefined && typeof e['internal'] !== 'boolean')
    return 'internal must be a boolean';
  if (e['httpStatus'] !== undefined && !Number.isInteger(e['httpStatus']))
    return 'httpStatus must be an integer';
  return null;
}

// Reads registries.json and checks its shape by hand (the kit has no runtime
// dependency); throws naming the registry and entry index of the first fault.
export function loadRegistry(path: URL = REGISTRY_PATH): Registry {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(raw)) throw new Error('registries.json: not an object');
  const extra = Object.keys(raw).find(
    (k) => !(REGISTRY_NAMES as readonly string[]).includes(k)
  );
  if (extra !== undefined)
    throw new Error(`registries.json: ${extra} is not a registry`);
  const out: Partial<Registry> = {};
  for (const name of REGISTRY_NAMES) {
    const entries = raw[name];
    if (entries === undefined)
      throw new Error(`registries.json: ${name} is missing`);
    if (!Array.isArray(entries))
      throw new Error(`registries.json: ${name} is not a list`);
    const list: unknown[] = entries;
    list.forEach((e, i) => {
      const why = entryProblem(name, e);
      if (why !== null)
        throw new Error(`registries.json: ${name}[${i}] ${why}`);
    });
    out[name] = list as RegistryEntry[];
  }
  return out as Registry;
}

const TITLES: Record<RegistryName, string> = {
  'address-schemes': '11.1 Address schemes',
  'address-characters': '11.2 Address characters',
  'envelope-fields': '11.3 Envelope fields',
  kinds: '11.4 Kinds',
  'ref-types': '11.5 Ref types',
  'gate-types': '11.6 Gate types',
  'system-markers': '11.7 System markers',
  'delivery-states': '11.8 Delivery states',
  'error-codes': '11.9 Error codes',
  'extension-uris': '11.10 Extension URIs',
};

// The spec file holding each top-level section or appendix.
const SECTION_FILES: readonly (readonly [string, string])[] = [
  ['0', '00-front-matter.md'],
  ['1', '01-introduction.md'],
  ['2', '02-terminology.md'],
  ['3', '03-addresses.md'],
  ['4', '04-messages.md'],
  ['5', '05-gates.md'],
  ['6', '06-delivery.md'],
  ['7', '07-mailboxes-and-channels.md'],
  ['8', '08-a2a-binding.md'],
  ['9', '09-identity-and-authorization.md'],
  ['10', '10-errors.md'],
  ['11', '11-registries.md'],
  ['12', '12-conformance.md'],
  ['13', '13-security-and-privacy.md'],
  ['14', '14-versioning.md'],
  ['A', 'appendix-a-daemon-api.md'],
  ['B', 'appendix-b-agent-tools.md'],
  ['C', 'appendix-c-dispatch-profile.md'],
  ['D', 'appendix-d-json-schemas.md'],
  ['E', 'appendix-e-examples.md'],
  ['F', 'appendix-f-federation.md'],
];

const POLICY_TEXT = `Every entry has a \`value\`; a \`scope\` (\`core\`, \`dispatch\`, \`a2a\`, \`memory\`, \`docs\` or \`federation\`); a \`status\`; the version it appeared in (\`since\`); the \`section\` that defines it; for a non-core entry, a \`reference\` to the public document that defines it; and the ids of its \`vectors\`. Gate types add who may raise them, their choices, their data and their effect; delivery states add whether a host MAY hide them from its external API; error codes add an HTTP status.

An entry has one of five statuses:

- **permanent**: normative, with at least one vector. An entry becomes permanent only in the change that adds its vectors.
- **provisional**: specified, with or without an implementation, and no vectors yet. A stable release lists its provisional entries in a separate table marked "not part of this version"; they become permanent in a later minor version. A receiver meets them through its unknown-value rule (5.6 for gate types, 4.4 for ref types).
- **appendix**: defined by an informative appendix (Appendix F). A host that does not implement the appendix MUST NOT emit it and MUST ignore it on input. It becomes permanent when its appendix becomes normative.
- **informative**: listed so implementers recognize it; raised by hosts or bindings, never by the engine; no vector.
- **reserved**: held for a stated use. A host MUST NOT use it; its only vectors check that it is refused.

New entries follow Specification Required: a public document plus at least one vector, and the editor's approval. Names starting \`x-\` are private use and are never registered, except the two system markers, which keep the \`x-\` spelling because stored messages carry it.

Drift rule: for each registry whose values an engine exports (address schemes, kinds, ref types, gate types, system markers, delivery states and error codes), every permanent entry is in the export, and every exported value has a permanent or provisional entry. A value already listed as provisional may be implemented without a registry change; any other new value needs a provisional entry in the same change.`;

// A table cell's text, with pipes escaped so they cannot split the cell.
function cell(text: string): string {
  return text.replaceAll('|', '\\|');
}

// Where a section number lives, for links from the registry tables.
function sectionLink(section: string): string {
  const file = SECTION_FILES.find(
    ([prefix]) => section === prefix || section.startsWith(`${prefix}.`)
  );
  return file === undefined
    ? `§${section}`
    : `[§${section}](${file[1]}#s${section})`;
}

function cells(name: RegistryName, e: RegistryEntry): string[] {
  const base = [
    `\`${e.value}\``,
    e.scope,
    e.status,
    e.since,
    sectionLink(e.section),
  ];
  const vectors =
    e.vectors.length === 0
      ? 'none'
      : e.vectors.map((v) => `\`${v}\``).join(', ');
  if (name === 'gate-types') {
    return [
      ...base,
      e.raisedBy ?? 'system',
      (e.choices ?? []).join(', '),
      e.effect ?? '',
      vectors,
    ];
  }
  if (name === 'delivery-states')
    return [...base, e.internal === true ? 'yes' : 'no', vectors];
  if (name === 'error-codes')
    return [...base, String(e.httpStatus ?? ''), vectors];
  return [...base, vectors];
}

function table(name: RegistryName, rows: readonly RegistryEntry[]): string {
  const extra =
    name === 'gate-types'
      ? ['Raised by', 'Choices', 'Effect']
      : name === 'delivery-states'
        ? ['Internal']
        : name === 'error-codes'
          ? ['HTTP status']
          : [];
  const head = [
    'Value',
    'Scope',
    'Status',
    'Since',
    'Defined in',
    ...extra,
    'Vectors',
  ];
  const line = (c: readonly string[]) => `| ${c.map(cell).join(' | ')} |`;
  return [
    line(head),
    line(head.map(() => '---')),
    ...rows.map((r) => line(cells(name, r))),
  ].join('\n');
}

// §11 as markdown, before oxfmt. A stable version moves provisional entries
// to a separate "not part of this version" table.
export function renderRegistries(registry: Registry, version: string): string {
  const stable = !version.includes('-');
  const parts = [
    '# 11 Registries',
    'This section is generated from `registries/registries.json` by `scripts/registries.ts`; edit the JSON, not this file. Registration policy is in 11.11.',
  ];
  for (const name of REGISTRY_NAMES) {
    const rows = registry[name];
    const listed = stable
      ? rows.filter((r) => r.status !== 'provisional')
      : rows;
    const later = stable ? rows.filter((r) => r.status === 'provisional') : [];
    parts.push(`## ${TITLES[name]}`, table(name, listed));
    if (later.length > 0)
      parts.push('Not part of this version (provisional):', table(name, later));
  }
  parts.push('## 11.11 Registration policy', POLICY_TEXT);
  return `${parts.join('\n\n')}\n`;
}
