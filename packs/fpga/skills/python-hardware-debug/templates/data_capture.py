#!/usr/bin/env python3
"""
FPGA 采数分析模板 — ILA/ChipScope 数据导入与解析

用途: 解析 FPGA ILA/ChipScope 导出的 CSV，分析时序波形和数据
支持: Vivado ILA CSV, ChipScope VCD, 通用二进制

用法:
    python data_capture.py --read csv --file ila_export.csv
    python data_capture.py --read bin --file capture.bin --fmt int16 --ch 4
    python data_capture.py --read csv --file ila.csv --trigger "valid=1"
    python data_capture.py --plot --file analysis.npz --sig "data_i,data_q"
"""

import argparse
import numpy as np
import matplotlib.pyplot as plt
from pathlib import Path


# ───────────────── 数据读取器 ─────────────────

class CSVReader:
    """Vivado ILA CSV 读取器"""

    def __init__(self, filepath: str):
        self.filepath = filepath
        self.signals = {}
        self.signal_names = []
        self.num_samples = 0
        self._parse()

    def _parse(self):
        """解析 ILA CSV 格式"""
        with open(self.filepath, 'r') as f:
            lines = f.readlines()

        # 跳过 Vivado 注释行 (以 # 开头)
        data_lines = [l.strip() for l in lines if l.strip() and not l.startswith('#')]

        if not data_lines:
            raise ValueError("Empty or unparseable CSV file")

        # 第一行是列名
        headers = data_lines[0].split(',')
        self.signal_names = [h.strip().strip('"') for h in headers]

        # 数据行
        for line in data_lines[1:]:
            values = line.split(',')
            for i, v in enumerate(values):
                if i >= len(self.signal_names):
                    break
                name = self.signal_names[i]
                if name not in self.signals:
                    self.signals[name] = []
                try:
                    self.signals[name].append(int(v.strip(), 2))  # 二进制值
                except ValueError:
                    try:
                        self.signals[name].append(int(v.strip(), 16))  # 十六进制
                    except ValueError:
                        try:
                            self.signals[name].append(float(v.strip()))  # 浮点
                        except ValueError:
                            self.signals[name].append(v.strip())  # 字符串

        self.num_samples = len(data_lines) - 1
        print(f"Loaded {self.num_samples} samples, {len(self.signal_names)} signals")

    def get_signal(self, name: str) -> np.ndarray:
        """按名称获取信号"""
        if name not in self.signals:
            raise KeyError(f"Signal '{name}' not found. Available: {self.signal_names}")
        return np.array(self.signals[name])

    def get_bus(self, names: list) -> np.ndarray:
        """获取总线 (多bit) 并合并为整数"""
        bus = np.zeros(self.num_samples, dtype=np.int64)
        for i, name in enumerate(names):
            sig = self.get_signal(name)
            bus = (bus << 1) | sig.astype(np.int64)
        return bus


class BinaryReader:
    """二进制 IQ 数据读取器"""

    def __init__(self, filepath: str, dtype: str = 'int16',
                 num_channels: int = 1, iq_interleaved: bool = True):
        """
        Parameters:
            dtype: numpy 数据类型字符串
            num_channels: 通道数
            iq_interleaved: I/Q 是否交织
        """
        self.filepath = filepath
        self.dtype = np.dtype(dtype)
        self.num_channels = num_channels
        self.iq_interleaved = iq_interleaved

        raw = np.fromfile(filepath, dtype=self.dtype)
        self.raw_data = raw

        if iq_interleaved and num_channels == 1:
            # 单通道 I/Q 交织
            self.iq = raw[0::2] + 1j * raw[1::2].astype(np.float64)
            self.shape = self.iq.shape
        elif iq_interleaved and num_channels > 1:
            # 多通道 I/Q 交织
            samples_per_frame = num_channels * 2
            n_frames = len(raw) // samples_per_frame
            frames = raw[:n_frames * samples_per_frame].reshape(-1, samples_per_frame)
            self.iq = frames[:, 0::2] + 1j * frames[:, 1::2]
            self.shape = self.iq.shape
        else:
            self.shape = raw.shape

    def get_channel(self, ch: int = 0) -> np.ndarray:
        """获取指定通道 IQ"""
        if self.iq_interleaved:
            if self.iq.ndim == 1:
                return self.iq
            return self.iq[:, ch]
        return self.raw_data

    def stats(self) -> dict:
        """统计信息"""
        if hasattr(self, 'iq'):
            data = self.iq.flatten()
            return {
                'mean_power': np.mean(np.abs(data)**2),
                'peak_power': np.max(np.abs(data)**2),
                'papr_db': 10 * np.log10(np.max(np.abs(data)**2) /
                                         np.mean(np.abs(data)**2)),
                'num_samples': len(data),
                'channel_shape': str(self.shape),
            }
        return {'num_samples': len(self.raw_data)}


# ───────────────── 分析工具 ─────────────────

def find_trigger(signals: dict, cond: str) -> np.ndarray:
    """
    找触发条件

    cond 格式: "signal_name=value"
    Returns: 触发索引数组
    """
    sig_name, value = cond.split('=')
    sig = signals[sig_name]

    try:
        val = int(value)
    except ValueError:
        val = value

    return np.where(np.array(sig) == val)[0]


def extract_window(data: np.ndarray, center: int, length: int) -> np.ndarray:
    """提取窗口数据"""
    half = length // 2
    start = max(0, center - half)
    end = min(len(data), center + half)
    return data[start:end]


# ───────────────── 可视化 ─────────────────

def plot_waveform(signals: dict, signal_names: list,
                  start: int = 0, length: int = 1000,
                  save_path: str = None):
    """显示波形"""
    n_sigs = len(signal_names)
    fig, axes = plt.subplots(n_sigs, 1, figsize=(12, 2 * n_sigs), sharex=True)

    if n_sigs == 1:
        axes = [axes]

    for i, name in enumerate(signal_names):
        data = signals.get(name, [])
        if len(data) == 0:
            continue
        seg = data[start:start + length]

        if np.issubdtype(np.array(seg).dtype, np.integer):
            axes[i].step(range(len(seg)), seg, where='mid')
        else:
            axes[i].plot(seg)

        axes[i].set_ylabel(name)
        axes[i].grid(True, alpha=0.3)

    axes[-1].set_xlabel('Sample Index')
    plt.suptitle('ILA Waveform')
    plt.tight_layout()

    if save_path:
        plt.savefig(save_path, dpi=150)
        print(f"波形已保存: {save_path}")
    plt.show()


def plot_iq_time(iq: np.ndarray, title: str = "IQ Time Domain",
                 sample_rate: float = None, save_path: str = None):
    """IQ 时域波形"""
    fig, axes = plt.subplots(2, 1, figsize=(12, 6), sharex=True)

    t = np.arange(len(iq))
    if sample_rate:
        t = t / sample_rate * 1e6  # μs

    axes[0].plot(t, iq.real, label='I', linewidth=0.5)
    axes[0].plot(t, iq.imag, label='Q', linewidth=0.5)
    axes[0].set_ylabel('Amplitude')
    axes[0].legend(); axes[0].grid(True, alpha=0.3)

    t_unit = 'μs' if sample_rate else 'samples'
    axes[1].plot(t, 20 * np.log10(np.abs(iq) + 1e-12))
    axes[1].set_xlabel(f'Time ({t_unit})')
    axes[1].set_ylabel('Power (dB)')
    axes[1].grid(True, alpha=0.3)

    plt.suptitle(title)
    plt.tight_layout()

    if save_path:
        plt.savefig(save_path, dpi=150)
    plt.show()


# ───────────────── 主程序 ─────────────────

def main():
    parser = argparse.ArgumentParser(description='FPGA 采数分析工具')
    parser.add_argument('--read', choices=['csv', 'bin'], default='csv',
                        help='读取模式')
    parser.add_argument('--file', '-f', required=True, help='数据文件')
    parser.add_argument('--fmt', default='int16', help='二进制格式')
    parser.add_argument('--ch', type=int, default=1, help='通道数')
    parser.add_argument('--trigger', '-t', help='触发条件 (sgn=val)')
    parser.add_argument('--sig', '-s', help='信号名列表 (逗号分隔)')
    parser.add_argument('--plot', action='store_true', help='显示波形')
    parser.add_argument('--start', type=int, default=0, help='起始采样')
    parser.add_argument('--length', type=int, default=1000, help='显示长度')
    parser.add_argument('--out', '-o', default=None, help='输出图片路径')
    args = parser.parse_args()

    if args.read == 'csv':
        reader = CSVReader(args.file)

        # 找触发
        if args.trigger:
            indices = find_trigger(reader.signals, args.trigger)
            print(f"Found {len(indices)} trigger matches")

        # 显示波形
        if args.plot:
            sigs = args.sig.split(',') if args.sig else reader.signal_names[:4]
            plot_waveform(reader.signals, sigs, args.start, args.length, args.out)

    elif args.read == 'bin':
        reader = BinaryReader(args.file, args.fmt, args.ch)
        stats = reader.stats()

        print(f"Binary read complete:")
        for k, v in stats.items():
            print(f"  {k}: {v}")

        # 时域图
        if args.plot:
            iq = reader.get_channel(0)
            plot_iq_time(iq, save_path=args.out)


if __name__ == '__main__':
    main()
