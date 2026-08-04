import { Editor } from '@pierre/diffs/edit';
import type { EditorOptions } from '@pierre/diffs/edit';
import { EditProvider, File } from '@pierre/diffs/react';
import { useCallback, useEffect, useMemo, useRef } from 'react';

interface TaskBodyEditorProps {
  /** Names the buffer, so the editor highlights it as markdown. */
  taskId: string;
  /** The body to open with. Read once — see the uncontrolled note below. */
  initialBody: string;
  onDraftChange: (body: string) => void;
}

/**
 * The task body as an editable markdown buffer, using @pierre/diffs' editor —
 * the same engine behind the run review diffs, so the two code surfaces in the
 * app look and behave alike.
 *
 * Deliberately uncontrolled: `initialBody` seeds the buffer at mount and is
 * never fed back in. The editor owns a piece table and an undo stack, so
 * pushing `contents` back on every keystroke would fight its own history and
 * reset the caret. Callers remount (by only rendering this while editing) to
 * start a new session against fresher text.
 */
export function TaskBodyEditor({
  taskId,
  initialBody,
  onDraftChange,
}: TaskBodyEditorProps) {
  // `editorOptions` reaches the Editor once, at construction, so a fresh
  // `onDraftChange` identity on a later render would never be picked up.
  // Reading it through a ref keeps every keystroke pointed at the current
  // callback without re-creating the editor.
  const onDraftChangeRef = useRef(onDraftChange);
  useEffect(() => {
    onDraftChangeRef.current = onDraftChange;
  }, [onDraftChange]);

  const createEditor = useCallback(
    (options: EditorOptions<undefined>) => new Editor(options),
    []
  );

  const editorOptions = useMemo<EditorOptions<undefined>>(
    () => ({
      onChange: (file) => onDraftChangeRef.current(file.contents),
    }),
    []
  );

  const file = useMemo(
    () => ({ name: `${taskId}.md`, contents: initialBody, cacheKey: taskId }),
    [taskId, initialBody]
  );

  return (
    <EditProvider createEditor={createEditor}>
      <File
        file={file}
        edit
        editorOptions={editorOptions}
        // No worker pool, unlike the multi-file diffs (see PierreWorkerPool).
        // @pierre/diffs already skips the pool while an edit session is active
        // and highlights on the main thread, so a pool here would allocate
        // workers for the life of the dialog and never be asked to do anything.
        disableWorkerPool
        // The filename header is noise here: the surrounding section already
        // says this is the task body.
        options={{ disableFileHeader: true }}
        className="border-border overflow-hidden rounded-md border"
      />
    </EditProvider>
  );
}
