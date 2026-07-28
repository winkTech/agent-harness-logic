'use strict';

/** Project applicability, trigger, and verification metadata for memory facts. */
module.exports = {
  name: '006-memory-scope',
  up: `
    ALTER TABLE facts ADD COLUMN project_id TEXT;
    ALTER TABLE facts ADD COLUMN scope_kind TEXT NOT NULL DEFAULT 'unscoped'
      CHECK(scope_kind IN ('unscoped', 'global_harness', 'repository', 'path', 'component', 'toolchain'));
    ALTER TABLE facts ADD COLUMN path_scope TEXT;
    ALTER TABLE facts ADD COLUMN trigger_kind TEXT;
    ALTER TABLE facts ADD COLUMN trigger_signature TEXT;
    ALTER TABLE facts ADD COLUMN verification_state TEXT NOT NULL DEFAULT 'candidate'
      CHECK(verification_state IN ('candidate', 'verified', 'needs_reverify'));
    ALTER TABLE facts ADD COLUMN evidence_ref TEXT;
    ALTER TABLE facts ADD COLUMN contract_hash TEXT;
    ALTER TABLE facts ADD COLUMN valid_until INTEGER;

    CREATE INDEX IF NOT EXISTS idx_facts_project_scope
      ON facts(project_id, scope_kind, status);
    CREATE INDEX IF NOT EXISTS idx_facts_trigger
      ON facts(trigger_kind, trigger_signature);
    CREATE INDEX IF NOT EXISTS idx_facts_verification
      ON facts(verification_state, valid_until);
  `,
};

