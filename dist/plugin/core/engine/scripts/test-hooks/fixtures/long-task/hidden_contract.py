import sys

sys.path.insert(0, "src")

from telemetry import parse_capture


def frame(seq, flags, payload):
    body = bytes([seq, flags, len(payload)]) + payload
    checksum = sum(body) & 0xFF
    return b"\xA5\x5A" + body + bytes([checksum])


def expect_value_error(name, capture):
    try:
        parse_capture(capture)
    except ValueError as exc:
        if "payload" not in str(exc).lower():
            raise SystemExit(f"{name}: ValueError message should mention payload, got: {exc}")
        return
    except Exception as exc:
        raise SystemExit(f"{name}: wrong exception type {type(exc).__name__}: {exc}")
    raise SystemExit(f"{name}: expected ValueError")


expect_value_error("partial-iq-pair", frame(1, 0, b"\x00\x01"))
print("hidden contract passed")
