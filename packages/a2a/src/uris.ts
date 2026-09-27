// The three Dispatch extensions; a breaking change mints /v2.
export const ENVELOPE_URI = 'https://dispatch.foo/a2a/ext/envelope/v1';
export const GATE_URI = 'https://dispatch.foo/a2a/ext/gate/v1';
export const WORK_URI = 'https://dispatch.foo/a2a/ext/work/v1';

export const EXTENSION_URIS = [ENVELOPE_URI, GATE_URI, WORK_URI] as const;
export type ExtensionUri = (typeof EXTENSION_URIS)[number];
