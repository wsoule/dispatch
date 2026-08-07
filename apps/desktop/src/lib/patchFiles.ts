import type { FileDiffMetadata } from '@pierre/diffs';
import { parsePatchFiles } from '@pierre/diffs';

// The outcome of splitting a raw patch: `error === null` means `files` holds
// the per-file diff metadata ready to render; otherwise `error` carries a
// human-readable message for the review pane to show inline instead of
// crashing the whole view. A flat shape (not a discriminated union) because
// this tsconfig runs without strictNullChecks, where TS won't narrow union
// discriminants on negative branches.
export interface SplitPatchResult {
  files: FileDiffMetadata[];
  error: string | null;
}

// Splits a raw multi-file git/unified patch (what dispatchd's
// `GET /api/runs/:id/diff` returns as `patch`) into one FileDiffMetadata per
// changed file, which is what `DiffSurface` turns into one `CodeView` item per
// file. The whole patch cannot simply be handed to a component: @pierre/diffs'
// `PatchDiff` is single-file by contract — it throws whenever a patch contains
// more than one file — so it must be parsed up front with `parsePatchFiles`.
// Never throws: parser failures and empty parses come back as an error
// result the caller can render as an inline message.
export function splitPatchFiles(patch: string): SplitPatchResult {
  try {
    const files = parsePatchFiles(patch).flatMap((parsed) => parsed.files);
    if (files.length === 0) {
      return { files: [], error: 'No file diffs found in patch' };
    }
    return { files, error: null };
  } catch (error) {
    return {
      files: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
