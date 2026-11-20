"""
802.11 BCC (Binary Convolutional Code) Encoder Golden Model

Implements the IEEE 802.11 convolutional encoder with:
  - Constraint length K=7 (6 memory elements)
  - Generator polynomials: G1=133_8, G2=171_8
  - Mother code rate: 1/2
  - Punctured rates: 2/3, 3/4, 5/6
  - Tail-biting termination (6 zero tail bits)

Reference: IEEE Std 802.11-2016, Section 17.3.5.6
"""

from __future__ import annotations

from typing import List, Tuple, Dict


class BCCEncoder:
    """802.11 BCC Encoder with constraint length K=7 and selectable code rate.

    The encoder uses a 6-element shift register and two generator polynomials
    to produce a rate-1/2 convolutional code. Higher code rates are achieved
    by puncturing the mother code output.

    Generator polynomials (octal):
        G1 = 133_8  -> taps at D0, D1, D3, D4, D6  -> A output
        G2 = 171_8  -> taps at D0, D2, D3, D5, D6  -> B output

    Shift register notation:
        D0: current input bit
        D1..D6: delayed versions (D1 = most recent past bit)
    """

    # Generator polynomial 1: 1 + D^2 + D^3 + D^5 + D^6
    G1: int = 0o133
    # Generator polynomial 2: 1 + D + D^3 + D^4 + D^6
    G2: int = 0o171

    # Tap masks for hardware-style bit extraction
    # A tap: D0(LSB), D1, D3, D4, D6
    _TAP_MASK_A: int = 0b0101111  # bit0=D0, bit1=D1, bit3=D3, bit4=D4, bit6=D6
    # B tap: D0(LSB), D2, D3, D5, D6
    _TAP_MASK_B: int = 0b0101101  # bit0=D0, bit2=D2, bit3=D3, bit5=D5, bit6=D6

    # Puncture matrices (row-major: [A1..Ak, B1..Bk])
    # Each entry: 1 = keep bit, 0 = discard bit
    PUNCTURE_MATRICES: Dict[float, List[int]] = {
        0.5: [1, 1],
        2 / 3: [1, 0, 1, 1],
        3 / 4: [1, 0, 1, 1, 1, 0],
        5 / 6: [1, 0, 1, 0, 1, 1, 0, 1, 1, 0],
    }

    # Number of input bits per puncture cycle for each rate
    _PUNCTURE_CYCLES: Dict[float, int] = {
        0.5: 1,
        2 / 3: 2,
        3 / 4: 3,
        5 / 6: 5,
    }

    # Number of tail bits for zero-termination (K-1 = 6)
    TAIL_BITS: int = 6

    def __init__(self, rate: float = 0.5) -> None:
        """Initialize BCC encoder.

        Args:
            rate: Code rate. One of 0.5, 2/3, 3/4, 5/6.

        Raises:
            ValueError: If rate is not supported.
        """
        self.shift_reg: int = 0  # 6-bit register, bit0=D1, ..., bit5=D6
        if rate not in self.PUNCTURE_MATRICES:
            raise ValueError(
                f"Unsupported code rate {rate}. "
                f"Valid rates: {list(self.PUNCTURE_MATRICES.keys())}"
            )
        self.rate: float = rate
        self.puncture_matrix: List[int] = self.PUNCTURE_MATRICES[rate]
        self.puncture_cycle: int = self._PUNCTURE_CYCLES[rate]

    def reset(self) -> None:
        """Reset the shift register to the all-zero state."""
        self.shift_reg = 0

    @property
    def state(self) -> int:
        """Current shift register state as a 6-bit integer (D1..D6)."""
        return self.shift_reg & 0x3F

    def encode_bit(self, inp: int) -> Tuple[int, int]:
        """Encode a single input bit, producing (A, B) output pair.

        The shift register is updated after computing the output.

        Args:
            inp: Input bit, 0 or 1.

        Returns:
            Tuple of (A, B) encoded bits.

        Raises:
            ValueError: If inp is not 0 or 1.
        """
        if inp not in (0, 1):
            raise ValueError(f"Input bit must be 0 or 1, got {inp}")

        # Extract individual shift register bits
        d1: int = (self.shift_reg >> 0) & 1
        d2: int = (self.shift_reg >> 1) & 1
        d3: int = (self.shift_reg >> 2) & 1
        d4: int = (self.shift_reg >> 3) & 1
        d5: int = (self.shift_reg >> 4) & 1
        d6: int = (self.shift_reg >> 5) & 1

        # A = D0 xor D1 xor D3 xor D4 xor D6  (G1=133)
        a: int = inp ^ d1 ^ d3 ^ d4 ^ d6

        # B = D0 xor D2 xor D3 xor D5 xor D6  (G2=171)
        b: int = inp ^ d2 ^ d3 ^ d5 ^ d6

        # Shift in the new bit (D1 <- D0, D2 <- D1, ..., D6 <- D5)
        self.shift_reg = ((self.shift_reg << 1) | inp) & 0x3F

        return (a, b)

    def set_rate(self, rate: float) -> None:
        """Change the code rate for subsequent encoding.

        This does NOT reset the encoder state.

        Args:
            rate: Code rate. One of 0.5, 2/3, 3/4, 5/6.

        Raises:
            ValueError: If rate is not supported.
        """
        if rate not in self.PUNCTURE_MATRICES:
            raise ValueError(
                f"Unsupported code rate {rate}. "
                f"Valid rates: {list(self.PUNCTURE_MATRICES.keys())}"
            )
        self.rate = rate
        self.puncture_matrix = self.PUNCTURE_MATRICES[rate]
        self.puncture_cycle = self._PUNCTURE_CYCLES[rate]

    def _puncture(self, raw_a: List[int], raw_b: List[int]) -> List[int]:
        """Apply puncturing to raw A/B encoded bit streams.

        The raw bits are grouped into puncture cycles of length
        ``puncture_cycle``. For each cycle, the A bits are followed
        by the B bits, and the puncture matrix selects which bits to
        keep.

        Args:
            raw_a: List of A-encoded bits.
            raw_b: List of B-encoded bits (same length as raw_a).

        Returns:
            List of punctured output bits.
        """
        cycle: int = self.puncture_cycle
        pm: List[int] = self.puncture_matrix
        output: List[int] = []

        n_cycles: int = (len(raw_a) + cycle - 1) // cycle

        for i in range(n_cycles):
            a_chunk: List[int] = raw_a[i * cycle : (i + 1) * cycle]
            b_chunk: List[int] = raw_b[i * cycle : (i + 1) * cycle]

            # Row-major order: [A1, A2, ..., Ak, B1, B2, ..., Bk]
            raw_chunk: List[int] = a_chunk + b_chunk

            for j, keep in enumerate(pm):
                if keep and j < len(raw_chunk):
                    output.append(raw_chunk[j])

        return output

    def encode(
        self,
        data: List[int],
        tail: bool = True,
    ) -> List[int]:
        """Encode a sequence of input bits with optional tail termination.

        Encoding flow:
          1. Encode data bits at the configured code rate (with puncturing).
          2. Optionally append 6 zero tail bits encoded at rate 1/2
             (no puncturing) to flush the shift register to zero.

        Args:
            data: List of input bits (each element 0 or 1).
            tail: If True (default), append 6 zero tail bits encoded at
                  rate 1/2.

        Returns:
            List of encoded output bits.

        Raises:
            ValueError: If any element of data is not 0 or 1.
        """
        self.reset()
        raw_a: List[int] = []
        raw_b: List[int] = []

        # Encode data bits
        for bit in data:
            a, b = self.encode_bit(bit)
            raw_a.append(a)
            raw_b.append(b)

        # Apply puncturing for the selected rate
        output: List[int] = self._puncture(raw_a, raw_b)

        # Tail termination: 6 zero bits at rate 1/2 (no puncturing)
        if tail:
            for _ in range(self.TAIL_BITS):
                t_a, t_b = self.encode_bit(0)
                output.append(t_a)
                output.append(t_b)

        return output

    def encode_with_state(
        self,
        data: List[int],
        tail: bool = True,
    ) -> Tuple[List[int], int]:
        """Encode data and return (output_bits, final_state).

        Useful for verifying the encoder returns to the zero state
        after tail bits.

        Args:
            data: List of input bits.
            tail: If True, append 6 zero tail bits.

        Returns:
            Tuple of (encoded output bits, final shift register state).
        """
        output: List[int] = self.encode(data, tail=tail)
        return (output, self.state)

    def get_expected_length(self, n_data_bits: int, tail: bool = True) -> int:
        """Compute the expected number of encoded output bits.

        Matches the actual puncture logic: input bits are grouped into
        puncture cycles; the last partial cycle may produce fewer
        output bits than a full cycle.

        Args:
            n_data_bits: Number of input data bits.
            tail: If True, include tail bits (12 additional bits).

        Returns:
            Expected output length.
        """
        cycle: int = self.puncture_cycle
        pm: List[int] = self.puncture_matrix

        n_full: int = n_data_bits // cycle
        n_partial: int = n_data_bits % cycle

        data_out: int = n_full * sum(pm)
        if n_partial > 0:
            # Partial cycle: only 2 * n_partial raw bits available
            data_out += sum(pm[: 2 * n_partial])

        tail_out: int = self.TAIL_BITS * 2 if tail else 0
        return data_out + tail_out

    def __repr__(self) -> str:
        return f"BCCEncoder(rate={self.rate})"
