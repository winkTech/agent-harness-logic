#!/usr/bin/env python3
"""802.11 Scrambler Golden Model -- x^7 + x^4 + 1, self-synchronizing

多项式: G(z) = z^7 + z^4 + 1 (7 阶 LFSR)
初始状态: 0x7F (全 1)
自同步: 加扰和解扰是同一操作 (XOR 的对称性)

工作原理:
  - 每个时钟周期移位一次
  - 反馈 = LFSR[6] XOR LFSR[3]
  - 输出 = 输入 bit XOR 反馈
  - 加扰 = 解扰

用法:
  # API
  from scrambler_gm import Scrambler
  s = Scrambler()
  scrambled = s.process(b"hello")
  s.reset()
  original = s.process(scrambled)

  # CLI
  python scrambler_gm.py --test
  python scrambler_gm.py --scramble 48656c6c6f
  python scrambler_gm.py --sequence
"""

from __future__ import annotations

import argparse
import sys
from typing import List


class Scrambler:
    """WiFi 802.11 加扰器/解扰器 (LFSR: x^7 + x^4 + 1)

    同时作为加扰器和解扰器使用 -- 自同步特性使两者操作完全相同。

    Attributes:
        POLY_TAPS: 抽头位置 (0-indexed), 对应 x^7 + x^4 + 1
        INIT_STATE: 初始状态 0x7F (7 位全 1)
    """

    POLY_TAPS = (6, 3)  # x^7 + x^4 + 1 -> 位索引 (0-based: 6, 3)
    INIT_STATE = 0x7F  # 初始状态全 1

    def __init__(self, init_state: int = INIT_STATE) -> None:
        """初始化 scrambler, 默认初始状态 0x7F"""
        self.state = init_state & 0x7F

    def reset(self, init_state: int = INIT_STATE) -> None:
        """复位 LFSR 到指定初始状态

        Args:
            init_state: 初始状态值 (低 7 位有效), 默认 0x7F
        """
        self.state = init_state & 0x7F

    def next_bit(self, inp: int) -> int:
        """处理一个 bit, 返回加扰/解扰后的 bit

        每个时钟周期:
          1. 计算反馈: fb = state[6] XOR state[3]
          2. 计算输出: out = inp XOR fb
          3. 状态更新: state = (state << 1 | fb) & 0x7F

        Args:
            inp: 输入 bit (0 或 1)

        Returns:
            加扰/解扰后的 bit (0 或 1)
        """
        tap1, tap2 = self.POLY_TAPS
        fb = ((self.state >> tap1) ^ (self.state >> tap2)) & 1
        out = (inp & 1) ^ fb
        self.state = ((self.state << 1) | fb) & 0x7F
        return out

    def process(self, data: bytes) -> bytes:
        """加扰/解扰字节序列 (LSB first per byte)

        按 802.11 标准, 每个字节的 bit 0 (LSB) 最先传输。

        Args:
            data: 输入字节序列

        Returns:
            加扰/解扰后的字节序列
        """
        result = bytearray(len(data))
        for idx, byte in enumerate(data):
            scrambled = 0
            for i in range(8):
                bit = (byte >> i) & 1
                scrambled |= self.next_bit(bit) << i
            result[idx] = scrambled
        return bytes(result)

    def process_bits(self, bits: List[int]) -> List[int]:
        """加扰/解扰 bit 列表

        用于 bit 级精确控制, 例如 SERVICE 字段的 7 个零 bit 处理。

        Args:
            bits: 输入 bit 列表 (每个元素 0 或 1)

        Returns:
            加扰/解扰后的 bit 列表
        """
        return [self.next_bit(b) for b in bits]

    def process_with_service(self, data: bytes) -> bytes:
        """加扰/解扰包含 SERVICE 字段的数据

        802.11 标准: SERVICE 字段的前 7 bits 置 0,
        用于 TX/RX 双方 LFSR 状态同步。
        先处理 7 个零 bit 使状态同步, 再处理 DATA。

        在接收端使用相同的 process_with_service 即可解扰:
            tx = Scrambler()
            scrambled = tx.process_with_service(data)

            rx = Scrambler()
            recovered = rx.process_with_service(scrambled)
            assert recovered == data  # 成立

        Args:
            data: SERVICE 字段之后的 DATA 字节

        Returns:
            加扰/解扰后的 DATA 字节 (状态已由 7 个零 bit 同步)
        """
        # SERVICE 字段同步: 前 7 bits 置 0
        for _ in range(7):
            self.next_bit(0)
        # DATA 加扰/解扰
        return self.process(data)


# ---- 内置测试向量 ----

_TEST_VECTORS = [
    {
        "name": "empty bytes",
        "data": b"",
        "check": "identity",
    },
    {
        "name": "single zero byte",
        "data": b"\x00",
        "check": "identity",
    },
    {
        "name": "short ASCII",
        "data": b"Hi!",
        "check": "identity",
    },
]

# 已知 LFSR 输出序列 (全零输入, 前 32 bits)
# 由 _generate_lfsr_sequence(32) 计算得到
KNOWN_LFSR_SEQ_32 = [
    0, 0, 0, 0, 1, 1, 1, 0,  # byte 0: 0x70
    1, 1, 1, 1, 0, 0, 1, 0,  # byte 1: 0x4F
    1, 1, 0, 0, 1, 0, 0, 1,  # byte 2: 0x93
    0, 0, 0, 0, 0, 0, 1, 0,  # byte 3: 0x40
]


def _generate_lfsr_sequence(length: int = 127) -> List[int]:
    """生成 LFSR 输出序列 (全零输入, 用于验证周期)"""
    s = Scrambler()
    return [s.next_bit(0) for _ in range(length)]


def _run_self_test() -> None:
    """内置测试: 验证 scrambler 正确性"""
    print("=" * 60)
    print("802.11 Scrambler Golden Model -- 自检")
    print("=" * 60)
    all_pass = True

    # 1. 复位与初始状态
    s = Scrambler()
    assert s.state == 0x7F, f"初始状态应为 0x7F, 实际 0x{s.state:02X}"
    print("[PASS] 初始状态 = 0x7F")

    s.reset(0x00)
    assert s.state == 0x00, f"reset(0) 后状态应为 0x00, 实际 0x{s.state:02X}"
    print("[PASS] reset(0x00) -> state = 0x00")

    s.reset()
    assert s.state == 0x7F, f"reset() 后状态应为 0x7F, 实际 0x{s.state:02X}"
    print("[PASS] reset() -> state = 0x7F")

    # 2. 加扰对称性: 加扰后再加扰 = 原文
    for v in _TEST_VECTORS:
        s1 = Scrambler()
        s2 = Scrambler()
        scrambled = s1.process(v["data"])
        descrambled = s2.process(scrambled)
        assert descrambled == v["data"], (
            f"加扰+解扰应恢复原文, data={v['data']!r}, "
            f"scrambled={scrambled!r}, recovered={descrambled!r}"
        )
        print(f'[PASS] 加扰+解扰对称性: {v["name"]!r}')

    # 3. process_bits 对称性
    s = Scrambler()
    bits = [1, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0]
    scrambled_bits = s.process_bits(bits)
    s2 = Scrambler()
    descrambled_bits = s2.process_bits(scrambled_bits)
    assert descrambled_bits == bits, "process_bits 加扰+解扰应恢复原文"
    print("[PASS] process_bits 加扰+解扰对称性")

    # 4. 全零输入 -> 已知 LFSR 输出模式
    s = Scrambler()
    actual = [s.next_bit(0) for _ in range(32)]
    assert actual == KNOWN_LFSR_SEQ_32, (
        f"全零输入 LFSR 序列不匹配\n"
        f"  期望: {KNOWN_LFSR_SEQ_32}\n"
        f"  实际: {actual}"
    )
    print("[PASS] 全零输入 LFSR 序列匹配已知模式")

    # 5. 全零加扰 -> 再解扰 -> 全零
    s = Scrambler()
    zero_input = bytes(16)
    scrambled_zero = s.process(zero_input)
    s_check = Scrambler()
    recovered = s_check.process(scrambled_zero)
    assert recovered == zero_input, "全零加扰后解扰应恢复全零"
    print("[PASS] 全零加扰 -> 解扰 -> 全零")

    # 6. LFSR 周期 = 127
    seq = _generate_lfsr_sequence(254)
    assert seq[:127] == seq[127:], "LFSR 输出周期应为 127"
    print("[PASS] LFSR 周期 = 127 (2^7 - 1)")

    # 7. SERVICE 字段: process_with_service 对称性
    s_enc = Scrambler()
    s_dec = Scrambler()
    data = bytes([0x42, 0x13, 0x37])
    enc = s_enc.process_with_service(data)
    dec = s_dec.process_with_service(enc)
    assert dec == data, (
        f"process_with_service 对称性验证失败\n"
        f"  data={data.hex()}, enc={enc.hex()}, dec={dec.hex()}"
    )
    print("[PASS] process_with_service SERVICE 字段同步对称性")

    # 8. process_with_service: 加扰后的 7 个同步 bit 应为已知序列
    s = Scrambler()
    sync_bits = s.process_bits([0] * 7)
    expected_sync = KNOWN_LFSR_SEQ_32[:7]
    assert sync_bits == expected_sync, (
        f"SERVICE 同步 bits 不匹配\n"
        f"  期望: {expected_sync}\n"
        f"  实际: {sync_bits}"
    )
    print(f"[PASS] SERVICE 同步 bits = {sync_bits}")

    # 9. 大块数据验证
    large_data = bytes(range(256))
    s1 = Scrambler()
    s2 = Scrambler()
    large_scrambled = s1.process(large_data)
    large_recovered = s2.process(large_scrambled)
    assert large_recovered == large_data, "256 字节数据加扰+解扰应恢复原文"
    print("[PASS] 256 字节大块数据加扰+解扰对称性")

    print("=" * 60)
    if all_pass:
        print("所有测试通过!")
    else:
        print("存在失败测试!")
        sys.exit(1)
    print("=" * 60)


def _cli_scramble(hex_str: str) -> None:
    """CLI: 加扰十六进制数据"""
    data = bytes.fromhex(hex_str)
    s = Scrambler()
    result = s.process(data)
    sys.stdout.write(result.hex() + "\n")


def _cli_descramble(hex_str: str) -> None:
    """CLI: 解扰十六进制数据"""
    # 加扰和解扰是同一操作
    _cli_scramble(hex_str)


def _cli_sequence(n: int) -> None:
    """CLI: 打印 LFSR 输出序列 (前 n bits)"""
    seq = _generate_lfsr_sequence(n)
    sys.stdout.write(" ".join(str(b) for b in seq) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="802.11 Scrambler Golden Model",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "示例:\n"
            "  python scrambler_gm.py --test          # 运行自检\n"
            "  python scrambler_gm.py --scramble 4865  # 加扰 0x4865\n"
            "  python scrambler_gm.py --descramble 4f  # 解扰 0x4f\n"
            "  python scrambler_gm.py --service 42     # SERVICE+数据加扰\n"
            "  python scrambler_gm.py --sequence 32    # 打印前 32 bits 序列\n"
        ),
    )
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--scramble", type=str, metavar="HEX", help="加扰十六进制数据")
    group.add_argument("--descramble", type=str, metavar="HEX", help="解扰十六进制数据 (同 --scramble)")
    group.add_argument("--service", type=str, metavar="HEX", help="SERVICE 字段 + DATA 加扰")
    group.add_argument("--test", action="store_true", help="运行内置测试向量验证")
    group.add_argument("--sequence", type=int, nargs="?", const=127, metavar="N",
                       help="打印 LFSR 输出序列 (前 N bits, 默认 127)")

    args = parser.parse_args()

    if args.test:
        _run_self_test()
    elif args.scramble is not None:
        _cli_scramble(args.scramble)
    elif args.descramble is not None:
        _cli_descramble(args.descramble)
    elif args.service is not None:
        data = bytes.fromhex(args.service)
        s = Scrambler()
        result = s.process_with_service(data)
        sys.stdout.write(result.hex() + "\n")
    elif args.sequence is not None:
        _cli_sequence(args.sequence)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
