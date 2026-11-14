"""Independent reference model for the normalized pulse_merge contract."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class PulseStep:
    count_out: int
    pulse_out: bool


class PulseMergeModel:
    def __init__(self, input_width: int, count_width: int) -> None:
        if input_width < 1 or count_width < 1:
            raise ValueError("input_width and count_width must be >= 1")
        self.input_width = input_width
        self.count_width = count_width
        self.mask = (1 << count_width) - 1
        self.input_mask = (1 << input_width) - 1
        self.count = 0
        self.pulse = False

    def reset(self) -> None:
        self.count = 0
        self.pulse = False

    def step(self, pulse_in: int, reset: bool = False) -> PulseStep:
        if not 0 <= pulse_in <= self.input_mask:
            raise ValueError("pulse_in exceeds INPUT_WIDTH")
        old_count = self.count
        if reset:
            self.reset()
        else:
            next_count = (old_count - 1 if old_count else 0) + pulse_in.bit_count()
            self.count = next_count & self.mask
            self.pulse = old_count != 0
        return PulseStep(self.count, self.pulse)

