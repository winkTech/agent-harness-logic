'use strict';

module.exports = {
  name: '005-memory-facts',
  up: `
    ALTER TABLE facts ADD COLUMN source_path TEXT;
    ALTER TABLE facts ADD COLUMN source_key TEXT;
    ALTER TABLE facts ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
      CHECK(status IN ('active', 'superseded', 'tombstone'));
    ALTER TABLE facts ADD COLUMN superseded_by TEXT;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_source_key
      ON facts(source_key) WHERE source_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_facts_status ON facts(status);
    CREATE INDEX IF NOT EXISTS idx_facts_source_path ON facts(source_path);
  `,
};
