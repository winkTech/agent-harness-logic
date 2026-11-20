"""
802.11 QAM Mapper — Golden Model

IEEE 802.11 compliant QAM modulation/demodulation with Gray coding.
Supports BPSK, QPSK, 16QAM, 64QAM, and 256QAM.

Features:
  - Gray-coded constellation mapping per 802.11-2016
  - Power normalization (switchable)
  - Fixed-point quantization (configurable fractional bits)
  - Hard-decision demapping (nearest-neighbor)
  - Soft-output LLR (max-log-MAP approximation)
  - Batch map/demap via numpy
"""

import math
import numpy as np
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple


@dataclass
class QAMConfig:
    """Modulation configuration parameters."""

    name: str
    bits_per_symbol: int
    norm_factor: float

    def __post_init__(self) -> None:
        self.norm_factor = float(self.norm_factor)


class QAMMapper:
    """802.11 QAM modulation mapper — Golden Model.

    Args:
        modulation: Modulation type.
            One of 'BPSK', 'QPSK', '16QAM', '64QAM', '256QAM'.
        norm: Enable power normalization (average symbol power = 1).
        fixed_point: If not None, quantize to N fractional bits (Q-format).

    Raises:
        ValueError: If modulation is not supported.
    """

    # ------------------------------------------------------------------
    # Modulation presets (802.11-2016 Section 17.3.5.8)
    # ------------------------------------------------------------------
    MODULATIONS: Dict[str, QAMConfig] = {
        'BPSK':  QAMConfig('BPSK', 1, 1.0),
        'QPSK':  QAMConfig('QPSK', 2, 1.0 / math.sqrt(2.0)),
        '16QAM': QAMConfig('16QAM', 4, 1.0 / math.sqrt(10.0)),
        '64QAM': QAMConfig('64QAM', 6, 1.0 / math.sqrt(42.0)),
        '256QAM': QAMConfig('256QAM', 8, 1.0 / math.sqrt(170.0)),
    }

    # Gray-coded constellation levels (unnormalized).
    #
    # Pattern (left-to-right, most-negative to most-positive):
    #
    #   16QAM I: level  -3   -1   +1   +3
    #            Gray   11   10   00   01
    #
    #   64QAM I: level  -7 -5 -3 -1 +1 +3 +5 +7
    #            Gray  000 001 011 010 110 111 101 100
    #
    #   256QAM I: extends the same Gray pattern to 16 levels.
    #
    # Q-axis uses the same Gray mapping as I-axis for all modulations.
    _CONSTELLATION: Dict[str, Dict] = {
        'BPSK': {
            'i_bits': 1,
            'I': {(0,): 1, (1,): -1},
            'Q': {(0,): 0, (1,): 0},
        },
        'QPSK': {
            'i_bits': 1,
            'I': {(0,): 1, (1,): -1},
            'Q': {(0,): 1, (1,): -1},
        },
        '16QAM': {
            'i_bits': 2,
            'I': {
                (0, 0): 1,
                (0, 1): 3,
                (1, 0): -1,
                (1, 1): -3,
            },
            'Q': {
                (0, 0): 1,
                (0, 1): 3,
                (1, 0): -1,
                (1, 1): -3,
            },
        },
        '64QAM': {
            'i_bits': 3,
            'I': {
                (0, 0, 0): -7, (0, 0, 1): -5,
                (0, 1, 1): -3, (0, 1, 0): -1,
                (1, 1, 0): 1, (1, 1, 1): 3,
                (1, 0, 1): 5, (1, 0, 0): 7,
            },
            'Q': {
                (0, 0, 0): -7, (0, 0, 1): -5,
                (0, 1, 1): -3, (0, 1, 0): -1,
                (1, 1, 0): 1, (1, 1, 1): 3,
                (1, 0, 1): 5, (1, 0, 0): 7,
            },
        },
        '256QAM': {
            'i_bits': 4,
            'I': {
                (0, 0, 0, 0): -15, (0, 0, 0, 1): -13,
                (0, 0, 1, 1): -11, (0, 0, 1, 0): -9,
                (0, 1, 1, 0): -7, (0, 1, 1, 1): -5,
                (0, 1, 0, 1): -3, (0, 1, 0, 0): -1,
                (1, 1, 0, 0): 1, (1, 1, 0, 1): 3,
                (1, 1, 1, 1): 5, (1, 1, 1, 0): 7,
                (1, 0, 1, 0): 9, (1, 0, 1, 1): 11,
                (1, 0, 0, 1): 13, (1, 0, 0, 0): 15,
            },
            'Q': {
                (0, 0, 0, 0): -15, (0, 0, 0, 1): -13,
                (0, 0, 1, 1): -11, (0, 0, 1, 0): -9,
                (0, 1, 1, 0): -7, (0, 1, 1, 1): -5,
                (0, 1, 0, 1): -3, (0, 1, 0, 0): -1,
                (1, 1, 0, 0): 1, (1, 1, 0, 1): 3,
                (1, 1, 1, 1): 5, (1, 1, 1, 0): 7,
                (1, 0, 1, 0): 9, (1, 0, 1, 1): 11,
                (1, 0, 0, 1): 13, (1, 0, 0, 0): 15,
            },
        },
    }

    def __init__(
        self,
        modulation: str = '16QAM',
        norm: bool = True,
        fixed_point: Optional[int] = None,
    ) -> None:
        if modulation not in self.MODULATIONS:
            raise ValueError(
                f"Unsupported modulation: {modulation}. "
                f"Supported: {list(self.MODULATIONS.keys())}"
            )

        self.modulation = modulation
        self.config = self.MODULATIONS[modulation]
        self.norm = norm
        self.fixed_point = fixed_point
        self._build_maps()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------
    def _build_maps(self) -> None:
        """Precompute reverse lookups and LLR tables."""
        const = self._CONSTELLATION[self.modulation]

        # Reverse:  level -> bit-tuple
        self._i_rev = {lv: bits for bits, lv in const['I'].items()}
        self._i_levels = sorted(const['I'].values())

        if self.modulation == 'BPSK':
            # BPSK has no Q-bit content
            self._q_rev = {}
            self._q_levels = [0.0]
            self._llr_i_tables = self._build_llr_1d_table(const['I'])
            self._llr_q_tables = []
            return

        self._q_rev = {lv: bits for bits, lv in const['Q'].items()}
        self._q_levels = sorted(const['Q'].values())
        self._llr_i_tables = self._build_llr_1d_table(const['I'])
        self._llr_q_tables = self._build_llr_1d_table(const['Q'])

    @staticmethod
    def _build_llr_1d_table(
        axis_map: Dict[Tuple[int, ...], int],
    ) -> List[List[Tuple[int, int]]]:
        """Build LLR lookup table for one axis.

        Returns a list (one entry per bit position) where each entry
        is a list of (level, bit_value) pairs.
        """
        n_bits = len(next(iter(axis_map.keys())))
        tables = []
        for pos in range(n_bits):
            entries = []
            for bits, level in axis_map.items():
                entries.append((level, bits[pos]))
            tables.append(entries)
        return tables

    def _quantize(self, value: float) -> float:
        """Round to fixed-point grid (if enabled)."""
        if self.fixed_point is not None:
            scale = 2.0 ** self.fixed_point
            return math.floor(value * scale + 0.5) / scale
        return value

    # ------------------------------------------------------------------
    # Single-symbol map / demap
    # ------------------------------------------------------------------
    def map(self, bits: List[int]) -> Tuple[float, float]:
        """Map one group of bits to an (I, Q) symbol.

        Args:
            bits: Bit list of length ``bits_per_symbol``.

        Returns:
            ``(I, Q)`` tuple.

        Raises:
            ValueError: If the bit count is incorrect or bits are invalid.
        """
        if len(bits) != self.config.bits_per_symbol:
            raise ValueError(
                f"Expected {self.config.bits_per_symbol} bits for "
                f"{self.modulation}, got {len(bits)}"
            )

        const = self._CONSTELLATION[self.modulation]
        bpi = const['i_bits']

        i_bits = tuple(bits[:bpi])
        try:
            i_val = const['I'][i_bits]
        except KeyError:
            raise ValueError(f"Invalid I-bit pattern: {i_bits}")

        if self.modulation == 'BPSK':
            q_val = 0.0
        else:
            q_bits = tuple(bits[bpi:])
            try:
                q_val = const['Q'][q_bits]
            except KeyError:
                raise ValueError(f"Invalid Q-bit pattern: {q_bits}")

        if self.norm:
            nf = self.config.norm_factor
            i_val *= nf
            if self.modulation != 'BPSK':
                q_val *= nf

        i_val = self._quantize(i_val)
        q_val = self._quantize(q_val)

        return (i_val, q_val)

    def demap(self, iq: Tuple[float, float]) -> List[int]:
        """Hard-decision demap (I, Q) to bits.

        Args:
            iq: ``(I, Q)`` tuple.

        Returns:
            List of bits.
        """
        i_val, q_val = iq

        if self.norm:
            nf = self.config.norm_factor
            i_val /= nf
            if self.modulation != 'BPSK':
                q_val /= nf

        # Nearest I level
        i_level = min(self._i_levels, key=lambda lv: abs(i_val - lv))
        i_bits = list(self._i_rev[i_level])

        if self.modulation == 'BPSK':
            return i_bits

        q_level = min(self._q_levels, key=lambda lv: abs(q_val - lv))
        q_bits = list(self._q_rev[q_level])
        return i_bits + q_bits

    # ------------------------------------------------------------------
    # Batch map / demap (numpy)
    # ------------------------------------------------------------------
    def map_symbols(self, bits: List[int]) -> np.ndarray:
        """Map a flat bit sequence to complex symbols.

        Args:
            bits: Flat bit list; length must be a multiple of
                ``bits_per_symbol``.

        Returns:
            Complex ndarray of shape ``(N,)``.
        """
        bps = self.config.bits_per_symbol
        if len(bits) % bps != 0:
            raise ValueError(
                f"Bit count ({len(bits)}) must be a multiple of "
                f"bits_per_symbol ({bps})"
            )

        n_sym = len(bits) // bps
        symbols = np.empty(n_sym, dtype=np.complex128)
        for i in range(n_sym):
            group = bits[i * bps: (i + 1) * bps]
            i_val, q_val = self.map(group)
            symbols[i] = i_val + 1.0j * q_val

        return symbols

    def demap_symbols(self, symbols: np.ndarray) -> List[int]:
        """Demap complex symbols back to a flat bit list.

        Args:
            symbols: Complex ndarray.

        Returns:
            Flat bit list.
        """
        bits: List[int] = []
        for s in symbols:
            bits.extend(self.demap((float(s.real), float(s.imag))))
        return bits

    # ------------------------------------------------------------------
    # LLR (max-log-MAP)
    # ------------------------------------------------------------------
    def calc_llr(
        self, iq: Tuple[float, float], noise_var: float
    ) -> List[float]:
        """Compute max-log-MAP LLR for each bit position.

        ``LLR(b_i) = (1/sigma^2) * [min|r - s0|^2 - min|r - s1|^2]``

        Args:
            iq: Received ``(I, Q)`` symbol (same scale as ``map()`` output).
            noise_var: Noise variance (in the same scale domain).

        Returns:
            List of LLR values, one per bit.
        """
        i_val, q_val = iq
        nf = self.config.norm_factor if self.norm else 1.0

        llrs: List[float] = []

        # I-axis bits
        for table in self._llr_i_tables:
            min_d0 = float('inf')
            min_d1 = float('inf')
            for level, bit_val in table:
                d = (i_val - level * nf) ** 2
                if bit_val == 0 and d < min_d0:
                    min_d0 = d
                elif bit_val == 1 and d < min_d1:
                    min_d1 = d

            if noise_var == 0.0:
                llrs.append(float('inf') if min_d0 > min_d1 else float('-inf'))
            else:
                llrs.append((min_d0 - min_d1) / noise_var)

        # Q-axis bits
        for table in self._llr_q_tables:
            min_d0 = float('inf')
            min_d1 = float('inf')
            for level, bit_val in table:
                d = (q_val - level * nf) ** 2
                if bit_val == 0 and d < min_d0:
                    min_d0 = d
                elif bit_val == 1 and d < min_d1:
                    min_d1 = d

            if noise_var == 0.0:
                llrs.append(float('inf') if min_d0 > min_d1 else float('-inf'))
            else:
                llrs.append((min_d0 - min_d1) / noise_var)

        return llrs

    # ------------------------------------------------------------------
    # Constellation visualisation
    # ------------------------------------------------------------------
    def get_constellation_points(self) -> np.ndarray:
        """Return all ideal constellation points as a complex array.

        The points are in the same domain (normalised or raw) as
        ``map()`` output.
        """
        const = self._CONSTELLATION[self.modulation]
        nf = self.config.norm_factor if self.norm else 1.0

        points: List[complex] = []
        for i_val in const['I'].values():
            if self.modulation == 'BPSK':
                points.append(i_val * nf + 0.0j)
            else:
                for q_val in const['Q'].values():
                    points.append(i_val * nf + 1.0j * q_val * nf)
        return np.array(points, dtype=np.complex128)
