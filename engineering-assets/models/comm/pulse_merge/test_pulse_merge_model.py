import random
import unittest

from pulse_merge_model import PulseMergeModel


class PulseMergeModelTests(unittest.TestCase):
    @staticmethod
    def state(result):
        return (result.count_out, result.pulse_out)

    def test_basic_and_multi_bit_addition(self) -> None:
        model = PulseMergeModel(4, 8)
        self.assertEqual(self.state(model.step(0)), (0, False))
        self.assertEqual(self.state(model.step(0b1011)), (3, False))
        self.assertEqual(self.state(model.step(0)), (2, True))
        self.assertEqual(self.state(model.step(0)), (1, True))
        self.assertEqual(self.state(model.step(0)), (0, True))
        self.assertEqual(self.state(model.step(0)), (0, False))

    def test_reset_flushes_credit_and_pulse(self) -> None:
        model = PulseMergeModel(4, 8)
        model.step(0b1111)
        self.assertEqual(self.state(model.step(0, reset=True)), (0, False))
        self.assertEqual(self.state(model.step(0)), (0, False))

    def test_bounded_random_never_overflows(self) -> None:
        rng = random.Random(0xC0DE)
        model = PulseMergeModel(4, 12)
        for cycle in range(1000):
            if cycle < 3 or cycle % 211 == 0:
                result = model.step(0, reset=True)
                self.assertEqual(self.state(result), (0, False))
                continue
            choice = rng.randrange(10)
            if choice < 6:
                pulse_in = 0
            elif choice < 9:
                pulse_in = 1 << rng.randrange(4)
            else:
                pulse_in = 0b0011
            result = model.step(pulse_in)
            self.assertLess(result.count_out, 1 << 12)


if __name__ == "__main__":
    unittest.main()
