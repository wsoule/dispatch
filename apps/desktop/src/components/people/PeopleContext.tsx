import type { Person } from '@dispatch-foo/core/browser';
import { canonicalAssignee } from '@dispatch-foo/core/browser';
import { createContext, useContext, useMemo } from 'react';

/** The project's people and who this window is — provided once by App, read by every
 * avatar and assignee picker so neither needs the registry threaded through its row. */
export interface PeopleDirectory {
  people: readonly Person[];
  /** Whom an assignee picker offers: everyone but a placeholder, which only
   *  names a task that already holds it. */
  assignable: readonly Person[];
  /** This window's own ref, or null until the daemon says. */
  me: string | null;
  /** The person an assignee names (the legacy bare `human` is `me`). */
  personFor: (assignee: string) => Person | undefined;
}

const EMPTY: PeopleDirectory = {
  people: [],
  assignable: [],
  me: null,
  personFor: () => undefined,
};

const PeopleContext = createContext<PeopleDirectory>(EMPTY);

export function PeopleProvider({
  people,
  me,
  children,
}: {
  people: readonly Person[];
  me: string | null;
  children: React.ReactNode;
}) {
  const value = useMemo<PeopleDirectory>(() => {
    const byRef = new Map(people.map((p) => [p.ref, p]));
    return {
      people,
      assignable: people.filter((p) => p.placeholder !== true),
      me,
      personFor: (assignee) =>
        byRef.get(me === null ? assignee : canonicalAssignee(assignee, me)),
    };
  }, [people, me]);
  return (
    <PeopleContext.Provider value={value}>{children}</PeopleContext.Provider>
  );
}

/** The directory, or an empty one outside App's provider (tests, the gallery). */
export function usePeople(): PeopleDirectory {
  return useContext(PeopleContext);
}
