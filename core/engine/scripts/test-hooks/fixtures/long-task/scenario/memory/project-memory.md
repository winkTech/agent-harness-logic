# Project Memory

This project uses CC1101-style burst debug frames captured from an FPGA bridge.

Frame format:

```text
byte 0      sync A5
byte 1      sync 5A
byte 2      sequence number, unsigned 8-bit
byte 3      flags, unsigned 8-bit
byte 4      payload length in bytes, must be even
byte 5..N   payload, packed I/Q pairs
last byte   checksum
```

Payload format:

- Every I/Q pair is 4 bytes: `I_hi I_lo Q_hi Q_lo`.
- I and Q are signed 16-bit big-endian integers.
- `payload length` is the number of payload bytes, not the number of pairs.
- A valid payload length must be a multiple of 4. Even-but-not-multiple-of-4
  lengths are corrupt partial I/Q records and must raise `ValueError`.
- RSSI dBm is derived from flags using `rssi_dbm = -100 + (flags & 0x1f)`.

Checksum:

- Sum every byte from sequence through the last payload byte.
- Keep the low 8 bits.
- The checksum byte must equal that low 8-bit value.

Important debugging lesson:

- Noise bytes before sync are common and must be ignored.
- Noise bytes after a complete frame may also appear before the next sync.
- A checksum mismatch means the capture is corrupt; raise `ValueError`.
