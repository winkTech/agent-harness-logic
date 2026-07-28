'use strict';

/** Consumer-scoped event watermarks and retention support. */
module.exports = {
  name: '004-memory-events',
  up: `
    CREATE TABLE IF NOT EXISTS runtime_consumer_watermarks (
      consumer   TEXT PRIMARY KEY,
      watermark  INTEGER NOT NULL DEFAULT 0 CHECK(watermark >= 0),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    INSERT OR IGNORE INTO runtime_consumer_watermarks (consumer, watermark)
    SELECT 'dream', watermark FROM runtime_watermark WHERE id = 1;

    INSERT OR IGNORE INTO runtime_consumer_watermarks (consumer, watermark)
    VALUES ('skill-evolve', 0);
  `,
};
