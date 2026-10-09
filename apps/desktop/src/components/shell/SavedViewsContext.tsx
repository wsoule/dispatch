import { createContext, useContext } from 'react';

import type { SavedViewsApi } from '../../hooks/useSavedViews';

/**
 * The active project's saved views and favorites (`useSavedViews`), provided by `App` so the
 * Tasks header's view tabs and the star on a task page read one instance. Null outside
 * the provider on purpose, so the Tasks page still renders in the browser-dev harness and in view tests that
 * mount none of App's providers; consumers show no star or saved-view tabs then.
 */
const SavedViewsContext = createContext<SavedViewsApi | null>(null);

export const SavedViewsProvider = SavedViewsContext.Provider;

export function useSavedViewsContext(): SavedViewsApi | null {
  return useContext(SavedViewsContext);
}
