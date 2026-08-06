import type { DiffsEditor } from '@pierre/diffs';
import type { EditorOptions } from '@pierre/diffs/edit';
import { Editor } from '@pierre/diffs/edit';

/**
 * The single place Pierre editor options are decided, so every editable surface
 * behaves the same. `persistState` keeps each file's caret and undo stack while
 * the reviewer moves between files, which needs a stable `cacheKey` per file —
 * the item builder uses the file path.
 */
export function createReviewEditor<T>(
  options: EditorOptions<T>
): DiffsEditor<T> {
  return new Editor<T>({
    ...options,
    persistState: true,
    matchBrackets: true,
    roundedSelection: true,
  });
}
