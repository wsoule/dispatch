// Renders an unvalidated value for a human-facing error message.
//
// Validation failures routinely carry a value that came off YAML frontmatter,
// a JSON request body, or a planner response, so its static type is `unknown`
// and it may well be a map or a list. Interpolating that directly yields
// "[object Object]", which tells a reader nothing about what they actually
// sent. Strings pass through unquoted so scalar messages read naturally
// ("invalid risk: urgent"); everything else goes through JSON.
export function describeValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? 'undefined';
  } catch {
    // YAML anchors and cyclic request bodies produce structures JSON refuses.
    return '[unserializable]';
  }
}
