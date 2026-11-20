"""Telemetry burst parsing helpers."""


def parse_capture(capture: bytes) -> list[dict]:
    """Parse a raw telemetry capture into frame dictionaries."""
    # TODO: implement the real parser.
    if not capture:
        return []
    return [{"seq": capture[0], "flags": 0, "iq": [], "rssi_dbm": -100}]


def summarize_capture(capture: bytes) -> dict:
    """Return a compact summary for a raw telemetry capture."""
    frames = parse_capture(capture)
    return {
        "frame_count": len(frames),
        "first_seq": frames[0]["seq"] if frames else None,
        "last_seq": frames[-1]["seq"] if frames else None,
        "avg_rssi_dbm": None,
        "iq_peak": 0,
    }
