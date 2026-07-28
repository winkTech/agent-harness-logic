"""Independent transaction-level model for stream_elastic_pipeline."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class StepResult:
    input_ready: bool
    output_valid: bool
    output_data: int
    input_transfer: bool
    output_transfer: bool


class ElasticPipelineModel:
    """A bounded ordered queue with the DUT's elastic ready semantics."""

    def __init__(self, data_width: int, depth: int) -> None:
        if data_width < 1:
            raise ValueError("data_width must be >= 1")
        if depth < 1:
            raise ValueError("depth must be >= 1")
        self.data_width = data_width
        self.depth = depth
        self.mask = (1 << data_width) - 1
        self._items: list[int] = []

    @property
    def occupancy(self) -> int:
        return len(self._items)

    def reset(self) -> None:
        self._items.clear()

    def step(self, valid: bool, data: int, ready: bool, reset: bool = False) -> StepResult:
        output_valid = bool(self._items)
        output_data = self._items[0] if output_valid else 0
        input_ready = len(self._items) < self.depth or (ready and output_valid)
        output_transfer = output_valid and ready and not reset
        input_transfer = bool(valid and input_ready and not reset)

        if reset:
            self.reset()
        else:
            if output_transfer:
                self._items.pop(0)
            if input_transfer:
                if len(self._items) >= self.depth:
                    raise AssertionError("model overflow")
                self._items.append(data & self.mask)

        return StepResult(
            input_ready=input_ready,
            output_valid=output_valid,
            output_data=output_data,
            input_transfer=input_transfer,
            output_transfer=output_transfer,
        )

