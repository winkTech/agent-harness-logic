import random
import unittest

from stream_elastic_pipeline_model import ElasticPipelineModel


class ElasticPipelineModelTests(unittest.TestCase):
    def test_basic_order_and_drain(self) -> None:
        model = ElasticPipelineModel(8, 2)
        self.assertFalse(model.step(False, 0, False).output_valid)
        for value in (0x11, 0x22):
            result = model.step(True, value, False)
            self.assertTrue(result.input_transfer)
        self.assertEqual(model.occupancy, 2)
        self.assertEqual(model.step(False, 0, True).output_data, 0x11)
        self.assertEqual(model.step(False, 0, True).output_data, 0x22)
        self.assertEqual(model.occupancy, 0)

    def test_stall_holds_head_and_allows_no_overflow(self) -> None:
        model = ElasticPipelineModel(8, 2)
        model.step(True, 1, False)
        model.step(True, 2, False)
        stalled = model.step(True, 3, False)
        self.assertFalse(stalled.input_ready)
        self.assertEqual(stalled.output_data, 1)
        self.assertEqual(model.occupancy, 2)
        released = model.step(True, 3, True)
        self.assertTrue(released.input_transfer)
        self.assertTrue(released.output_transfer)
        self.assertEqual(model.occupancy, 2)

    def test_reset_flushes_inflight_items(self) -> None:
        model = ElasticPipelineModel(8, 4)
        model.step(True, 0xA5, False)
        model.step(True, 0x5A, False)
        model.step(False, 0, False, reset=True)
        self.assertEqual(model.occupancy, 0)
        self.assertFalse(model.step(False, 0, True).output_valid)

    def test_randomized_conservation(self) -> None:
        rng = random.Random(0x5EED)
        model = ElasticPipelineModel(12, 4)
        accepted: list[int] = []
        emitted: list[int] = []
        for cycle in range(2000):
            reset = cycle < 3 or (cycle % 173 == 0)
            valid = bool(rng.getrandbits(1))
            ready = bool(rng.getrandbits(1))
            data = rng.randrange(1 << 12)
            result = model.step(valid, data, ready, reset)
            if reset:
                accepted.clear()
                emitted.clear()
            if result.input_transfer:
                accepted.append(data & 0xFFF)
            if result.output_transfer:
                emitted.append(result.output_data)
        while model.occupancy:
            result = model.step(False, 0, True)
            if result.output_transfer:
                emitted.append(result.output_data)
        self.assertEqual(emitted, accepted)


if __name__ == "__main__":
    unittest.main()
