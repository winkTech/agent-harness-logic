#!/usr/bin/env python3
"""
星座图绘制模板 — QPSK/8PSK/16QAM/64QAM/256QAM

用途: FPGA调试时快速查看解调后的星座图质量
依赖: numpy, matplotlib

用法:
    python constellation.py --file iq_data.csv
    python constellation.py --file iq_data.bin --fmt bin --fs 30.72e6
    python constellation.py --file iq_data.csv --mod 16qam --sym 10000
"""

import argparse
import sys
import numpy as np
import matplotlib.pyplot as plt
from pathlib import Path


def load_iq_csv(filepath: str) -> np.ndarray:
    """从 CSV 加载 IQ 数据 (两列: I, Q)"""
    data = np.loadtxt(filepath, delimiter=',')
    if data.ndim == 1:
        data = data.reshape(-1, 2)
    return data[:, 0] + 1j * data[:, 1]


def load_iq_binary(filepath: str, dtype_str: str = 'int16') -> np.ndarray:
    """从二进制文件加载 IQ 数据 (I/Q 交织)"""
    raw = np.fromfile(filepath, dtype=np.dtype(dtype_str))
    iq = raw[0::2] + 1j * raw[1::2]
    return iq.astype(np.complex64)


def plot_constellation(iq: np.ndarray, title: str = "Constellation",
                       num_points: int = 5000, save_path: str = None):
    """
    绘制星座图

    Parameters:
        iq: 复 IQ 数据
        title: 图标题
        num_points: 显示的最大点数
        save_path: 保存路径 (可选)
    """
    # 归一化
    iq = iq / np.std(iq)

    # 抽取显示点
    if len(iq) > num_points:
        idx = np.random.choice(len(iq), num_points, replace=False)
        iq = iq[idx]

    fig, ax = plt.subplots(1, 1, figsize=(8, 8))
    ax.plot(iq.real, iq.imag, '.', markersize=1, alpha=0.6)
    ax.axhline(0, color='gray', linewidth=0.5)
    ax.axvline(0, color='gray', linewidth=0.5)
    ax.set_xlabel('I')
    ax.set_ylabel('Q')
    ax.set_title(title)
    ax.set_aspect('equal')
    ax.grid(True, alpha=0.3)

    # 添加理想星座点参考 (16QAM)
    if '16' in title.lower() or '16qam' in title.lower():
        ref = np.array([-3, -1, 1, 3]) / np.sqrt(10)
        x, y = np.meshgrid(ref, ref)
        ax.plot(x, y, 'rx', markersize=8, label='Ideal')
        ax.legend()

    plt.tight_layout()

    if save_path:
        plt.savefig(save_path, dpi=150)
        print(f"星座图已保存: {save_path}")
    plt.show()


def main():
    parser = argparse.ArgumentParser(description='星座图绘制工具')
    parser.add_argument('--file', '-f', required=True, help='IQ 数据文件')
    parser.add_argument('--fmt', choices=['csv', 'bin'], default='csv',
                        help='文件格式 (默认 csv)')
    parser.add_argument('--mod', default='qpsk',
                        help='调制方式 (qpsk/8psk/16qam/64qam/256qam)')
    parser.add_argument('--sym', type=int, default=5000,
                        help='显示的最大符号数')
    parser.add_argument('--out', '-o', default=None, help='输出图片路径')
    args = parser.parse_args()

    # 加载数据
    if args.fmt == 'csv':
        iq = load_iq_csv(args.file)
    else:
        iq = load_iq_binary(args.file)

    print(f"Loaded {len(iq)} symbols from {args.file}")
    print(f"EVM (est): {np.std(np.abs(iq)) / np.mean(np.abs(iq)) * 100:.2f}%")

    # 绘制
    title = f"{args.mod.upper()} Constellation"
    plot_constellation(iq, title, args.sym, args.out)


if __name__ == '__main__':
    main()
