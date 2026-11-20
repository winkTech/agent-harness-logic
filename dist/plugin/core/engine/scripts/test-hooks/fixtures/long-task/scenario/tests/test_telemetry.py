import pytest

from telemetry import parse_capture, summarize_capture


def frame(seq, flags, payload):
    body = bytes([seq, flags, len(payload)]) + payload
    checksum = sum(body) & 0xFF
    return b"\xA5\x5A" + body + bytes([checksum])


def test_parse_single_frame_with_signed_iq():
    capture = frame(
        7,
        0b0001_0101,
        b"\x00\x10\xff\xf0\x80\x00\x7f\xff",
    )

    frames = parse_capture(capture)

    assert frames == [
        {
            "seq": 7,
            "flags": 0b0001_0101,
            "iq": [(16, -16), (-32768, 32767)],
            "rssi_dbm": -79,
        }
    ]


def test_parse_multiple_frames_and_skip_noise():
    capture = (
        b"\x00\x13noise"
        + frame(1, 0x01, b"\x00\x01\x00\x02")
        + b"\x99"
        + frame(2, 0x05, b"\xff\xff\x00\x03")
    )

    frames = parse_capture(capture)

    assert [f["seq"] for f in frames] == [1, 2]
    assert frames[0]["iq"] == [(1, 2)]
    assert frames[1]["iq"] == [(-1, 3)]


def test_checksum_mismatch_raises():
    bad = bytearray(frame(9, 0x02, b"\x00\x01\x00\x02"))
    bad[-1] ^= 0xFF

    with pytest.raises(ValueError, match="checksum"):
        parse_capture(bytes(bad))


def test_odd_payload_length_raises():
    bad = b"\xA5\x5A" + bytes([3, 1, 3, 0, 1, 2])
    bad += bytes([sum(bad[2:]) & 0xFF])

    with pytest.raises(ValueError, match="payload length"):
        parse_capture(bad)


def test_partial_iq_pair_payload_length_raises():
    bad = frame(4, 0x01, b"\x00\x01")

    with pytest.raises(ValueError, match="payload"):
        parse_capture(bad)


def test_summary():
    capture = (
        frame(10, 0x01, b"\x00\x01\x00\x02")
        + frame(11, 0x03, b"\xff\xfe\x00\x04")
    )

    assert summarize_capture(capture) == {
        "frame_count": 2,
        "first_seq": 10,
        "last_seq": 11,
        "avg_rssi_dbm": -98.0,
        "iq_peak": 4,
    }
