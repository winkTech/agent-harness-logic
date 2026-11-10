'use strict';

/** Latest bounded execution evidence for each explicitly registered consumer. */
module.exports = {
  name: '007-consumer-heartbeats',
  up: `
    CREATE TABLE IF NOT EXISTS runtime_consumer_heartbeats (
      consumer           TEXT PRIMARY KEY,
      run_id             TEXT NOT NULL,
      status             TEXT NOT NULL
                           CHECK(status IN ('running','success','skipped','failed')),
      last_started_at    TEXT NOT NULL,
      last_completed_at  TEXT,
      last_exit          INTEGER,
      processed_through  INTEGER NOT NULL DEFAULT 0 CHECK(processed_through >= 0),
      processed_count    INTEGER NOT NULL DEFAULT 0 CHECK(processed_count >= 0),
      pending_count      INTEGER NOT NULL DEFAULT 0 CHECK(pending_count >= 0),
      next_due_at        TEXT,
      last_error         TEXT,
      updated_at         TEXT NOT NULL
    );
  `,
};
