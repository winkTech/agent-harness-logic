#!/usr/bin/env python3
"""
BER 误码率统计与分析模板

用途: FPGA 链路级 BER 测试，支持 AWGN 仿真和实测数据分析
支持: BPSK/QPSK/8PSK/16QAM/64QAM 调制方式的 BER 统计

用法:
    python ber_test.py --sim --mod qpsk --ebno 0:10 --num 100000
    python ber_test.py --sim --mod 16qam --ebno 0:8 --num 50000 --out ber_curve.png
    python ber_test.py --file tx_bits.csv --rx rx_bits.csv --mod qpsk
    python ber_test.py --analyze --file ber_log.csv
"""

import argparse
import numpy as np
import matplotlib.pyplot as plt
from pathlib import Path


# ───────────────── 调制映射 ─────────────────

def modulate(bits: np.ndarray, modulation: str) -> np.ndarray:
    """比特 → 调制符号"""
    if modulation.lower() == 'bpsk':
        symbols = 2 * bits - 1
    elif modulation.lower() == 'qpsk':
        symbols = (2*bits[0::2]-1 + 1j*(2*bits[1::2]-1)) / np.sqrt(2)
    elif modulation.lower() == '8psk':
        # Gray-mapped 8PSK
        phases = np.zeros(len(bits) // 3, dtype=float)
        for i in range(0, len(bits) - 2, 3):
            idx = bits[i]*4 + bits[i+1]*2 + bits[i+2]
            phases[i//3] = idx * np.pi / 4 + np.pi/8
        symbols = np.exp(1j * phases)
    elif modulation.lower() == '16qam':
        i_map = np.array([-3, -1, 1, 3]) / np.sqrt(10)
        q_map = np.array([-3, -1, 1, 3]) / np.sqrt(10)
        sym_i = i_map[bits[0::4]*2 + bits[1::4]]
        sym_q = q_map[bits[2::4]*2 + bits[3::4]]
        symbols = sym_i + 1j * sym_q
    elif modulation.lower() == '64qam':
        i_vals = np.array([-7,-5,-3,-1,1,3,5,7]) / np.sqrt(42)
        q_vals = np.array([-7,-5,-3,-1,1,3,5,7]) / np.sqrt(42)
        sym_i = i_vals[bits[0::6]*4 + bits[1::6]*2 + bits[2::6]]
        sym_q = q_vals[bits[3::6]*4 + bits[4::6]*2 + bits[5::6]]
        symbols = sym_i + 1j * sym_q
    else:
        raise ValueError(f"Unsupported modulation: {modulation}")
    return symbols


def demodulate(symbols: np.ndarray, modulation: str) -> np.ndarray:
    """解调 (硬判决)"""
    if modulation.lower() == 'bpsk':
        bits = (symbols.real > 0).astype(int)
    elif modulation.lower() == 'qpsk':
        bits = np.empty(len(symbols) * 2, dtype=int)
        bits[0::2] = (symbols.real > 0).astype(int)
        bits[1::2] = (symbols.imag > 0).astype(int)
    elif modulation.lower() == '16qam':
        i_map = np.array([-3, -1, 1, 3]) / np.sqrt(10)
        q_map = np.array([-3, -1, 1, 3]) / np.sqrt(10)
        bits = np.empty(len(symbols) * 4, dtype=int)
        # I demapping
        i_sym = symbols.real
        bits[0::4] = (i_sym > 0).astype(int)
        bits[1::4] = (np.abs(i_sym) < 2/np.sqrt(10)).astype(int) ^ bits[0::4]
        # Q demapping
        q_sym = symbols.imag
        bits[2::4] = (q_sym > 0).astype(int)
        bits[3::4] = (np.abs(q_sym) < 2/np.sqrt(10)).astype(int) ^ bits[2::4]
    elif modulation.lower() == '64qam':
        # Simplified hard decision
        i_vals = np.array([-7,-5,-3,-1,1,3,5,7]) / np.sqrt(42)
        dec_i = np.argmin(np.abs(symbols.real[:, None] - i_vals[None, :]), axis=1)
        dec_q = np.argmin(np.abs(symbols.imag[:, None] - q_vals[None, :]), axis=1)
        bits = np.empty(len(symbols) * 6, dtype=int)
        bits[0::6] = (dec_i >> 2) & 1
        bits[1::6] = (dec_i >> 1) & 1
        bits[2::6] = dec_i & 1
        bits[3::6] = (dec_q >> 2) & 1
        bits[4::6] = (dec_q >> 1) & 1
        bits[5::6] = dec_q & 1
    else:
        raise ValueError(f"Unsupported modulation: {modulation}")
    return bits


# ───────────────── 信道模型 ─────────────────

def awgn_channel(symbols: np.ndarray, ebno_db: float,
                 bits_per_sym: int) -> np.ndarray:
    """AWGN 信道的符号级实现"""
    # 符号能量
    es = np.mean(np.abs(symbols)**2)

    # 信噪比
    ebno_linear = 10**(ebno_db / 10)
    snr = ebno_linear * bits_per_sym
    no = es / snr

    # 加噪
    noise = np.sqrt(no / 2) * (np.random.randn(len(symbols)) +
                                1j * np.random.randn(len(symbols)))
    return symbols + noise


# ───────────────── BER 测试 ─────────────────

BITS_PER_SYM = {
    'bpsk': 1, 'qpsk': 2, '8psk': 3,
    '16qam': 4, '64qam': 6, '256qam': 8
}


def ber_test_sim(modulation: str, ebno_range: str,
                 num_bits: int = 100000, seed: int = 42) -> np.ndarray:
    """链路 BER 仿真"""
    np.random.seed(seed)

    # 解析 Eb/N0 范围
    if ':' in ebno_range:
        parts = ebno_range.split(':')
        ebno_values = np.arange(float(parts[0]), float(parts[1]) + 1)
    else:
        ebno_values = np.array([float(ebno_range)])

    bps = BITS_PER_SYM[modulation.lower()]
    ber_results = np.zeros(len(ebno_values))

    for i, ebno in enumerate(ebno_values):
        # 生成随机比特
        tx_bits = np.random.randint(0, 2, num_bits)

        # 补齐到整符号
        if len(tx_bits) % bps != 0:
            tx_bits = tx_bits[:-(len(tx_bits) % bps)]

        # 调制
        symbols = modulate(tx_bits, modulation)

        # 信道
        rx_symbols = awgn_channel(symbols, ebno, bps)

        # 解调
        rx_bits = demodulate(rx_symbols, modulation)

        # 统计 BER
        min_len = min(len(tx_bits), len(rx_bits))
        errors = np.sum(tx_bits[:min_len] != rx_bits[:min_len])
        ber = errors / min_len
        ber_results[i] = ber

        print(f"  Eb/N0={ebno:3.0f} dB: BER={ber:.2e} ({errors}/{min_len})")

    return ebno_values, ber_results


def ber_test_file(tx_file: str, rx_file: str, modulation: str = None) -> dict:
    """实测文件 BER 统计"""
    tx = np.loadtxt(tx_file, delimiter=',').astype(int).flatten()
    rx = np.loadtxt(rx_file, delimiter=',').astype(int).flatten()

    min_len = min(len(tx), len(rx))
    errors = np.sum(tx[:min_len] != rx[:min_len])
    ber = errors / min_len if min_len > 0 else 1.0

    return {
        'total_bits': min_len,
        'errors': errors,
        'ber': ber,
        'modulation': modulation or 'unknown',
    }


# ───────────────── 理论 BER ─────────────────

def theoretical_ber(ebno_db: np.ndarray, modulation: str) -> np.ndarray:
    """理论 BER 曲线 (AWGN)"""
    ebno_lin = 10**(ebno_db / 10)

    if modulation.lower() == 'bpsk':
        return 0.5 * erfc(np.sqrt(ebno_lin))
    elif modulation.lower() == 'qpsk':
        return 0.5 * erfc(np.sqrt(ebno_lin))
    elif modulation.lower() == '16qam':
        # 近似
        return 0.375 * erfc(np.sqrt(0.4 * ebno_lin))
    elif modulation.lower() == '64qam':
        return 0.4375 * erfc(np.sqrt(0.143 * ebno_lin))
    else:
        return np.zeros_like(ebno_db)


def erfc(x: np.ndarray) -> np.ndarray:
    """互补误差函数 (使用 scipy 或近似)"""
    try:
        from scipy.special import erfc as scipy_erfc
        return scipy_erfc(np.sqrt(x))
    except ImportError:
        # 近似 (有效 x > 0)
        return np.exp(-x) / (np.sqrt(np.pi * x) + 1e-12)


# ───────────────── 可视化 ─────────────────

def plot_ber_curve(ebno_db: np.ndarray, ber: np.ndarray, modulation: str,
                    theo_ber: np.ndarray = None, save_path: str = None):
    """BER 曲线"""
    fig, ax = plt.subplots(1, 1, figsize=(10, 7))

    # 仿真结果
    ax.semilogy(ebno_db, ber, 'o-', linewidth=1.5, markersize=6,
                label=f'{modulation.upper()} (sim)')

    # 理论曲线
    if theo_ber is not None:
        ax.semilogy(ebno_db, theo_ber, '--', linewidth=1, alpha=0.7,
                    label=f'{modulation.upper()} (theory)')

    ax.set_xlabel('Eb/N0 (dB)')
    ax.set_ylabel('BER')
    ax.set_title(f'BER Performance — {modulation.upper()}')
    ax.grid(True, which='both', alpha=0.3)
    ax.legend()

    # 参考线
    ax.axhline(1e-3, color='gray', linestyle=':', alpha=0.5)
    ax.axhline(1e-6, color='gray', linestyle=':', alpha=0.5)

    plt.tight_layout()
    if save_path:
        plt.savefig(save_path, dpi=150)
        print(f"BER 曲线已保存: {save_path}")
    plt.show()


def main():
    parser = argparse.ArgumentParser(description='BER 误码率分析工具')
    parser.add_argument('--sim', action='store_true', help='仿真模式')
    parser.add_argument('--mod', default='qpsk', help='调制方式')
    parser.add_argument('--ebno', default='0:10', help='Eb/N0 范围 (开始:结束)')
    parser.add_argument('--num', type=int, default=100000, help='每点比特数')
    parser.add_argument('--file', help='发送比特文件 (实测模式)')
    parser.add_argument('--rx', help='接收比特文件')
    parser.add_argument('--out', '-o', default=None, help='输出图片路径')
    parser.add_argument('--seed', type=int, default=42, help='随机种子')
    args = parser.parse_args()

    if args.sim:
        print(f"Running BER simulation: {args.mod}, Eb/N0 range={args.ebno}")
        ebno, ber = ber_test_sim(args.mod, args.ebno, args.num, args.seed)

        # 理论曲线
        theo_ber = theoretical_ber(ebno, args.mod)

        # 绘制
        plot_ber_curve(ebno, ber, args.mod, theo_ber, args.out)

    elif args.file and args.rx:
        result = ber_test_file(args.file, args.rx, args.mod)
        print(f"\nBER Results:")
        print(f"  Modulation:  {result['modulation']}")
        print(f"  Total Bits:  {result['total_bits']:,}")
        print(f"  Errors:      {result['errors']:,}")
        print(f"  BER:         {result['ber']:.2e}")


if __name__ == '__main__':
    main()
