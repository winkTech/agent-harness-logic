# Telemetry Burst Parser

The user's real need is to make the field-debug telemetry analyzer reliable.
The current parser only works for a toy frame, and production captures contain
multiple concatenated frames, noise bytes before frames, and signed sensor
payloads.

Implement `parse_capture` and `summarize_capture` in `src/telemetry.py`.

Acceptance criteria:

- Parse every valid frame in a `bytes` capture.
- Skip noise bytes until the next frame sync.
- Validate checksum and raise `ValueError` on checksum mismatch.
- Reject payloads that do not contain complete 4-byte I/Q pairs, and raise
  `ValueError` with a message that mentions `payload`.
- Decode signed 16-bit big-endian I/Q samples.
- Return dictionaries with `seq`, `flags`, `iq`, and `rssi_dbm`.
- Summaries must include `frame_count`, `first_seq`, `last_seq`,
  `avg_rssi_dbm`, and `iq_peak`.
- Do not modify tests.
- Run `python -m pytest -q` before final response.
