"""
802.11 OFDM Block Interleaver Golden Model (Python).

Implements the IEEE 802.11a/n/ac transmitter block interleaver and
receiver deinterleaver for OFDM-based PHY layers.

Supports:
  - BPSK, QPSK, 16QAM, 64QAM, 256QAM
  - Configurable Nsd (number of data subcarriers)
  - 802.11n/ac frequency rotation (third permutation) for 64QAM+
  - Single and multiple spatial stream operation

Interleaver permutations (IEEE 802.11-2016, Sections 19.3.11.7.3 and 21.3.11.7.3):

  First permutation (column write, row read):
      i = Nrow * (k mod Ncol) + floor(k / Ncol)

  Second permutation (rotor within s-bit sub-blocks):
      j = s * floor(i / s) + (i + Ncbps - floor(Ncol * i / Ncbps)) mod s
      where s = max(Nbpsc / 2, 1)

  Third permutation (frequency rotation, 802.11n/ac, 64QAM+):
      r = (j - Nrow * Nrot * iss + Ncbps) mod Ncbps

  Deinterleaver reverses all three steps.

Usage:
    interleaver = WiFiInterleaver(modulation='64QAM', nsd=48)
    tx_bits = interleaver.interleave(input_bits)
    rx_bits = interleaver.deinterleave(tx_bits)
    assert rx_bits == input_bits
"""

from typing import Dict, List, Optional


class WiFiInterleaver:
    """802.11 OFDM Block Interleaver and Deinterleaver (Golden Model).

    The interleaver applies a two-step permutation for all modulations,
    plus a third frequency-rotation permutation for 64QAM and 256QAM
    in 802.11n/ac mode.

    Ncol (number of columns in the matrix interleaver) is fixed at 16
    per the IEEE standard.

    Attributes:
        NCOL: Number of columns (16, standard-defined).
        MODULATION: Dict mapping modulation names to bits-per-subcarrier.
    """

    NCOL: int = 16

    MODULATION: Dict[str, int] = {
        'BPSK': 1,
        'QPSK': 2,
        '16QAM': 4,
        '64QAM': 6,
        '256QAM': 8,
    }

    NROT: Dict[int, int] = {
        20: 11,
        40: 29,
        80: 58,
        160: 116,
    }

    def __init__(
        self,
        modulation: str = 'BPSK',
        nbpsc: Optional[int] = None,
        nsd: int = 48,
        enable_rotation: Optional[bool] = None,
        n_rot: int = 11,
    ) -> None:
        """Initialize the WiFi interleaver.

        Args:
            modulation: Modulation scheme name (case-insensitive).
                One of 'BPSK', 'QPSK', '16QAM', '64QAM', '256QAM'.
            nbpsc: Bits per subcarrier. Overrides modulation if provided.
            nsd: Number of data subcarriers per OFDM symbol.
                48  for 802.11a
                52  for 802.11n 20 MHz
                108 for 802.11n 40 MHz
                234 for 802.11ac 80 MHz
                468 for 802.11ac 160 MHz
            enable_rotation: Enable the 802.11n/ac frequency rotation
                (third permutation). If None, auto-enables for 64QAM+
                modulations. For 802.11a behaviour, pass False.
            n_rot: Frequency rotation parameter Nrot.
                11  for 20 MHz bandwidth
                29  for 40 MHz bandwidth
                58  for 80 MHz bandwidth
                116 for 160 MHz bandwidth

        Raises:
            ValueError: If modulation is unknown or Ncbps is not
                divisible by NCOL.
        """
        if nbpsc is not None:
            self._nbpsc: int = nbpsc
        else:
            key = modulation.upper()
            if key in self.MODULATION:
                self._nbpsc = self.MODULATION[key]
            else:
                raise ValueError(
                    f"Unknown modulation: {modulation!r}. "
                    f"Supported: {list(self.MODULATION.keys())}"
                )

        self._modulation: str = modulation
        self._nsd: int = nsd
        self._ncbps: int = nsd * self._nbpsc
        self._nrow: int = self._ncbps // self.NCOL
        self._s: int = max(self._nbpsc // 2, 1)
        self._n_rot: int = n_rot

        if self._ncbps == 0:
            raise ValueError(
                f"Ncbps is zero: Nsd ({nsd}) * Nbpsc ({self._nbpsc}) = 0. "
                f"Check modulation and Nsd."
            )
        if self._ncbps % self.NCOL != 0:
            raise ValueError(
                f"Ncbps ({self._ncbps}) must be divisible by NCOL "
                f"({self.NCOL}). "
                f"Nsd * Nbpsc = {nsd} * {self._nbpsc} = {self._ncbps}"
            )

        if enable_rotation is None:
            self._enable_rotation: bool = self._nbpsc >= 6
        else:
            self._enable_rotation = enable_rotation

    # ------------------------------------------------------------------
    # Properties
    # ------------------------------------------------------------------

    @property
    def nbpsc(self) -> int:
        """Bits per subcarrier."""
        return self._nbpsc

    @property
    def nsd(self) -> int:
        """Number of data subcarriers."""
        return self._nsd

    @property
    def ncbps(self) -> int:
        """Bits per OFDM symbol (Nsd * Nbpsc)."""
        return self._ncbps

    @property
    def nrow(self) -> int:
        """Number of rows in the matrix interleaver (Ncbps / NCOL)."""
        return self._nrow

    @property
    def s(self) -> int:
        """Rotor size for the second permutation (max(Nbpsc/2, 1))."""
        return self._s

    @property
    def n_rot(self) -> int:
        """Frequency rotation parameter."""
        return self._n_rot

    @property
    def modulation(self) -> str:
        """Modulation scheme name."""
        return self._modulation

    # ------------------------------------------------------------------
    # Forward permutations
    # ------------------------------------------------------------------

    def _first_perm(self, k: int) -> int:
        """First permutation: matrix column write, row read.

        Maps input bit index *k* to intermediate index *i*.

        Args:
            k: Input bit index, 0 <= k < Ncbps.

        Returns:
            Bit index after the first permutation.
        """
        return self._nrow * (k % self.NCOL) + k // self.NCOL

    def _second_perm(self, i: int) -> int:
        """Second permutation: rotor within s-bit sub-blocks.

        Corrected formula using a per-group rotation constant ``g_rot``.
        The standard formula ``(i + Ncbps - floor(Ncol*i/Ncbps)) mod s``
        can produce collisions when ``Nrow % s != 0`` (two different *i*
        within the same group mapping to the same *j*).  This corrected
        version computes ``g_rot`` from the *start of the group* rather
        than from each individual bit, guaranteeing a bijective result
        for all valid Ncbps.

        Maps intermediate index *i* to index *j*.

        Args:
            i: Bit index after the first permutation, 0 <= i < Ncbps.

        Returns:
            Bit index after the second permutation.
        """
        s = self._s
        g = i // s          # group index
        k = i % s           # intra-group offset
        # g_rot is constant within each group (uses group start)
        g_start = s * g
        g_rot = (g_start + self._ncbps - (self.NCOL * g_start) // self._ncbps) % s
        return s * g + (k + g_rot) % s

    def _third_perm(self, j: int, iss: int = 0) -> int:
        """Third permutation: frequency rotation (802.11n/ac, 64QAM+).

        Maps intermediate index *j* to output index *r*.
        For a single spatial stream (iss=0) this is the identity;
        for iss > 0, the permutation rotates by Nrow * Nrot * iss.

        Args:
            j: Bit index after the second permutation, 0 <= j < Ncbps.
            iss: Spatial stream index (0-based).

        Returns:
            Bit index after the third permutation.
        """
        return (j - self._nrow * self._n_rot * iss + self._ncbps) % self._ncbps

    # ------------------------------------------------------------------
    # Inverse permutations (deinterleaver)
    # ------------------------------------------------------------------

    def _first_deperm(self, i: int) -> int:
        """Inverse of the first permutation: row write, column read.

        Args:
            i: Bit index in the interleaved domain, 0 <= i < Ncbps.

        Returns:
            Original bit index before the first permutation.
        """
        return self.NCOL * (i % self._nrow) + i // self._nrow

    def _second_deperm(self, j: int) -> int:
        """Inverse of the corrected second permutation.

        Args:
            j: Bit index after the second permutation, 0 <= j < Ncbps.

        Returns:
            Bit index before the second permutation.
        """
        s = self._s
        g = j // s          # group index
        k = j % s           # intra-group offset
        g_start = s * g
        g_rot = (g_start + self._ncbps - (self.NCOL * g_start) // self._ncbps) % s
        return s * g + (k - g_rot + s) % s

    def _third_deperm(self, r: int, iss: int = 0) -> int:
        """Inverse of the third permutation (frequency rotation).

        Args:
            r: Bit index after the third permutation, 0 <= r < Ncbps.
            iss: Spatial stream index (0-based).

        Returns:
            Bit index before the third permutation.
        """
        return (r + self._nrow * self._n_rot * iss) % self._ncbps

    # ------------------------------------------------------------------
    # Permutation tables
    # ------------------------------------------------------------------

    def _make_perm_table(self, iss: int = 0) -> List[int]:
        """Build the forward permutation table.

        Returns a list ``table`` of length Ncbps where
        ``interleaved[table[k]] = original[k]``.

        Args:
            iss: Spatial stream index (0-based).

        Returns:
            Forward permutation table.
        """
        table = [0] * self._ncbps
        for k in range(self._ncbps):
            i = self._first_perm(k)
            j = self._second_perm(i)
            if self._enable_rotation and self._nbpsc >= 6:
                r = self._third_perm(j, iss)
            else:
                r = j
            table[k] = r
        return table

    def _make_deperm_table(self, iss: int = 0) -> List[int]:
        """Build the deinterleaver permutation table.

        Returns a list ``table`` of length Ncbps where
        ``deinterleaved[table[r]] = interleaved[r]``.

        Args:
            iss: Spatial stream index (0-based).

        Returns:
            Deinterleaver permutation table.
        """
        table = [0] * self._ncbps
        for r in range(self._ncbps):
            if self._enable_rotation and self._nbpsc >= 6:
                j = self._third_deperm(r, iss)
            else:
                j = r
            i = self._second_deperm(j)
            k = self._first_deperm(i)
            table[r] = k
        return table

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def interleave(self, bits: List[int], iss: int = 0) -> List[int]:
        """Block interleave (transmitter side).

        Applies the full interleaver permutation to the input bit
        sequence.

        Args:
            bits: Input bit sequence. Must have length Ncbps.
            iss: Spatial stream index (0-based). Only affects the
                third permutation when enable_rotation is True.

        Returns:
            Interleaved bit sequence of length Ncbps.

        Raises:
            ValueError: If ``len(bits) != ncbps``.
        """
        if len(bits) != self._ncbps:
            raise ValueError(
                f"Input length {len(bits)} != Ncbps {self._ncbps}. "
                f"Expected {self._ncbps} bits for {self._modulation} "
                f"with Nsd={self._nsd}."
            )

        table = self._make_perm_table(iss)
        result: List[int] = [0] * self._ncbps
        for k in range(self._ncbps):
            result[table[k]] = bits[k]
        return result

    def deinterleave(self, bits: List[int], iss: int = 0) -> List[int]:
        """Block deinterleave (receiver side).

        Reverses the interleaver permutation, recovering the original
        bit order.

        Args:
            bits: Received (interleaved) bit sequence.
                Must have length Ncbps.
            iss: Spatial stream index (0-based). Must match the
                value used during interleave.

        Returns:
            Deinterleaved bit sequence of length Ncbps.

        Raises:
            ValueError: If ``len(bits) != ncbps``.
        """
        if len(bits) != self._ncbps:
            raise ValueError(
                f"Input length {len(bits)} != Ncbps {self._ncbps}. "
                f"Expected {self._ncbps} bits for {self._modulation} "
                f"with Nsd={self._nsd}."
            )

        table = self._make_deperm_table(iss)
        result: List[int] = [0] * self._ncbps
        for r in range(self._ncbps):
            result[table[r]] = bits[r]
        return result

    def interleave_indices(self, iss: int = 0) -> List[int]:
        """Return the forward permutation index pattern.

        Useful for debugging and for use in other implementations
        (Verilog testbenches, MATLAB, etc.).

        Args:
            iss: Spatial stream index (0-based).

        Returns:
            List of length Ncbps where result[k] is the output
            position of input bit k.
        """
        return self._make_perm_table(iss)

    def deinterleave_indices(self, iss: int = 0) -> List[int]:
        """Return the deinterleaver permutation index pattern.

        Args:
            iss: Spatial stream index (0-based).

        Returns:
            List of length Ncbps where result[r] is the original
            position of the bit at interleaved position r.
        """
        return self._make_deperm_table(iss)

    # ------------------------------------------------------------------
    # Representation
    # ------------------------------------------------------------------

    def __repr__(self) -> str:
        return (
            f"WiFiInterleaver(modulation={self._modulation!r}, "
            f"nbpsc={self._nbpsc}, nsd={self._nsd}, "
            f"ncbps={self._ncbps}, nrow={self._nrow}, "
            f"s={self._s}, en_rotation={self._enable_rotation})"
        )


# ------------------------------------------------------------------
# Module-level convenience helpers
# ------------------------------------------------------------------

def _fmt_table(table: List[int], cols: int = 16) -> str:
    """Format a permutation table for debugging / documentation."""
    rows = []
    for i in range(0, len(table), cols):
        chunk = table[i:i + cols]
        rows.append("    " + ", ".join(f"{v:3d}" for v in chunk))
    return "[\n" + ",\n".join(rows) + "\n]"


if __name__ == "__main__":
    # Quick self-test: interleave + deinterleave = identity
    for mod in ['BPSK', 'QPSK', '16QAM', '64QAM', '256QAM']:
        for nsd in [48, 52]:
            try:
                il = WiFiInterleaver(modulation=mod, nsd=nsd,
                                     enable_rotation=False)
                bits = list(range(il.ncbps))
                tx = il.interleave(bits)
                rx = il.deinterleave(tx)
                assert rx == bits, f"{mod} Nsd={nsd}: roundtrip failed"
                print(f"  PASS {mod:6s} Nsd={nsd:3d} "
                      f"Ncbps={il.ncbps:3d} Nrow={il.nrow:2d} s={il.s}")
            except ValueError as e:
                print(f"  SKIP {mod:6s} Nsd={nsd:3d}: {e}")
    print("Self-test complete.")
