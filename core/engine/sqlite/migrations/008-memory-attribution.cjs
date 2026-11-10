'use strict';

/** Evidence-only memory attribution. Temporal correlation never claims causality. */
module.exports = {
  name: '008-memory-attribution',
  up: `
    CREATE TABLE IF NOT EXISTS memory_retrieval_exposures (
      exposure_id          TEXT PRIMARY KEY,
      retrieval_id         TEXT NOT NULL,
      correlation_id       TEXT NOT NULL,
      session_id           TEXT NOT NULL,
      project_id           TEXT NOT NULL,
      memory_id            TEXT NOT NULL,
      trigger_kind         TEXT NOT NULL
        CHECK(trigger_kind IN ('user-query','task-context','tool-failure','rule-trigger')),
      query_sha256         TEXT NOT NULL,
      target_path          TEXT,
      anchor_tool          TEXT,
      anchor_input_sha256  TEXT,
      anchor_consumed_at   INTEGER,
      rank                 INTEGER NOT NULL DEFAULT 1 CHECK(rank >= 1),
      confidence           REAL NOT NULL CHECK(confidence >= 0.0 AND confidence <= 1.0),
      status               TEXT NOT NULL DEFAULT 'emitted'
        CHECK(status IN ('emitted','verified-pass','verified-fail','unverified','expired')),
      emitted_at           INTEGER NOT NULL,
      expires_at           INTEGER NOT NULL,
      UNIQUE(retrieval_id, memory_id),
      UNIQUE(exposure_id, retrieval_id, session_id, project_id, memory_id)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_exposure_scope
      ON memory_retrieval_exposures(session_id, project_id, status, emitted_at);
    CREATE INDEX IF NOT EXISTS idx_memory_exposure_memory
      ON memory_retrieval_exposures(memory_id, emitted_at);

    CREATE TABLE IF NOT EXISTS memory_applications (
      application_id       TEXT PRIMARY KEY,
      exposure_id          TEXT NOT NULL,
      retrieval_id         TEXT NOT NULL,
      correlation_id       TEXT NOT NULL,
      session_id           TEXT NOT NULL,
      project_id           TEXT NOT NULL,
      memory_id            TEXT NOT NULL,
      event_name           TEXT NOT NULL,
      tool_name            TEXT NOT NULL,
      action_sha256        TEXT NOT NULL,
      target_path          TEXT,
      evidence_kind        TEXT NOT NULL
        CHECK(evidence_kind IN ('observed-followup','trigger-match','rule-enforced')),
      evidence_strength    TEXT NOT NULL
        CHECK(evidence_strength IN ('weak','medium','strong')),
      causal_claim         TEXT NOT NULL DEFAULT 'unproven'
        CHECK(causal_claim = 'unproven'),
      observed_at          INTEGER NOT NULL,
      UNIQUE(exposure_id, correlation_id, action_sha256),
      UNIQUE(application_id, exposure_id, retrieval_id, session_id, project_id, memory_id),
      FOREIGN KEY(exposure_id, retrieval_id, session_id, project_id, memory_id)
        REFERENCES memory_retrieval_exposures(
          exposure_id, retrieval_id, session_id, project_id, memory_id
        ) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_memory_application_scope
      ON memory_applications(session_id, project_id, observed_at);

    CREATE TABLE IF NOT EXISTS memory_outcomes (
      outcome_id           TEXT PRIMARY KEY,
      application_id       TEXT NOT NULL,
      exposure_id          TEXT NOT NULL,
      retrieval_id         TEXT NOT NULL,
      correlation_id       TEXT NOT NULL,
      session_id           TEXT NOT NULL,
      project_id           TEXT NOT NULL,
      memory_id            TEXT NOT NULL,
      verdict              TEXT NOT NULL CHECK(verdict IN ('pass','fail','inconclusive')),
      accepted             INTEGER NOT NULL CHECK(accepted IN (0, 1)),
      reason               TEXT NOT NULL,
      command_sha256       TEXT NOT NULL,
      stdout_sha256        TEXT NOT NULL,
      stderr_sha256        TEXT NOT NULL,
      evidence_source      TEXT NOT NULL CHECK(evidence_source = 'verification-gate'),
      causal_claim         TEXT NOT NULL DEFAULT 'unproven'
        CHECK(causal_claim = 'unproven'),
      observed_at          INTEGER NOT NULL,
      UNIQUE(exposure_id, correlation_id, command_sha256, stdout_sha256, stderr_sha256),
      FOREIGN KEY(application_id, exposure_id, retrieval_id, session_id, project_id, memory_id)
        REFERENCES memory_applications(
          application_id, exposure_id, retrieval_id, session_id, project_id, memory_id
        ) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_memory_outcome_scope
      ON memory_outcomes(session_id, project_id, verdict, observed_at);
  `,
};
