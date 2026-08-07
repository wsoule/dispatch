// Hyphens are kept so SKUs like "AB-1200" survive tokenisation — task t-0c9b88.
export function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter((t) => t.length > 0);
}
