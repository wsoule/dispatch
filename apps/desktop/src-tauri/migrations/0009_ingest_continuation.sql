ALTER TABLE ingest_state ADD COLUMN parser_context TEXT;
ALTER TABLE ingest_state ADD COLUMN partial_bytes BLOB;
