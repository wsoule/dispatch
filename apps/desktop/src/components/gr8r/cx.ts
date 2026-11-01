/** Joins class names, skipping the empty ones: the CSS-module stand-in for `cn`, without
    Tailwind's merge (module classes never conflict). */
export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}
