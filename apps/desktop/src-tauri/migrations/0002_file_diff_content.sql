-- Captures the raw before/after text for each file change, straight from the tool_use
-- record at ingest time (old_string/new_string for Edit/MultiEdit/NotebookEdit, content
-- for Write with old_content left NULL since no pre-write state exists in the log). Lets
-- the "view diff" UI compute a real diff on demand instead of just opening the file in an
-- editor, which only ever shows current-on-disk state, not what a specific past edit did.
-- Nullable so old rows ingested before this migration existed just show as unavailable.
ALTER TABLE files_changed ADD COLUMN old_content TEXT;
ALTER TABLE files_changed ADD COLUMN new_content TEXT;
