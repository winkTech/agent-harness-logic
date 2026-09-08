#!/usr/bin/env python3
"""
频偏估计与补偿模板

用途: 从 FPGA 捕获的 IQ 数据中估计载波频偏 (CFO) 并补偿
方法:
  - 短前导自相关 (LTS/STS)
  - 循环前缀自相关 (CP-based)
  - FFT 包络法 (宽范围搜索)

用法:
    python freq_estimate.py --file iq.bin --fs 30.72e6 --method cp
    python freq_estimate.py --file iq.csv --fs 15.36e6 --method lts
"""

import argparse
import numpy as np
import matplotlib.pyplot as plt


def load_iq(filepath: str) -> np.ndarray:
    """从 CSV 或二进制加载 IQ"""
    ext = filepath.lower().rsplit('.', 1)[-1]
    if ext in ('csv', 'txt'):
        data = np.loadtxt(filepath, delimiter=',')
        if data.ndim == 1:
            data = data.reshape(-1, 2)
        return data[:, 0] + 1j * data[:, 1]
    elif ext == 'bin':
        raw = np.fromfile(filepath, dtype=np.int16)
        return (raw[0::2] + 1j * raw[1::2]).astype(np.complex64)
    else:
        raise ValueError(f"Unknown format: {ext}")


def estimate_cfo_cp(iq: np.ndarray, fft_size: int, cp_len: int) -> float:
    """
    基于循环前缀 (CP) 的自相关频偏估计

    原理: CP 是 OFDM 符号尾部的复制，相位差 = 2π·Δf·N_FFT/fs

    Returns: 归一化 CFO (子载波间隔为单位)
    """
    n_sym = len(iq) // (fft_size + cp_len)
    phase_diffs = []

    for i in range(n_sym):
        start = i * (fft_size + cp_len)
        cp = iq[start:start + cp_len]
        tail = iq[start + fft_size:start + fft_size + cp_len]

        # 自相关
        corr = np.sum(cp * np.conj(tail))
        phase = np.angle(corr)
        phase_diffs.append(phase)

    cfo_norm = np.mean(phase_diffs) / (2 * np.pi)
    return cfo_norm


def estimate_cfo_lts(iq: np.ndarray, lts_len: int = 64) -> float:
    """
    基于长训练序列 (LTS) 的频偏估计

    原理: 两个相同的 LTS 符号的相位差
    适用: 有前导结构的帧 (WiFi/LTE-like)
    """
    if len(iq) < 2 * lts_len:
        raise ValueError(f"Need at least {2*lts_len} samples, got {len(iq)}")

    lts1 = iq[:lts_len]
    lts2 = iq[lts_len:2*lts_len]

    corr = np.sum(lts1 * np.conj(lts2))
    phase = np.angle(corr)
    cfo_norm = phase / (2 * np.pi)
    return cfo_norm


def estimate_cfo_fft(iq: np.ndarray, fs: float, fft_n: int = 4096) -> float:
    """
    基于 FFT 包络的频偏估计 (宽范围搜索)

    适用于: 未知前导结构，大频偏场景
    Returns: CFO 频率值 (Hz)
    """
    n_fft = min(fft_n, len(iq))
    window = np.hanning(n_fft)

    # 分段 FFT 平均
    n_seg = len(iq) // n_fft
    spec = np.zeros(n_fft // 2)

    for i in range(min(n_seg, 10)):
        seg = iq[i * n_fft:(i + 1) * n_fft] * window
        seg_spec = np.abs(np.fft.fft(seg)[:n_fft // 2]) ** 2
        spec += seg_spec

    spec /= min(n_seg, 10)

    # 找峰值
    peak_idx = np.argmax(spec)
    freq_bins = np.fft.fftfreq(n_fft, 1/fs)[:n_fft // 2]
    cfo_hz = freq_bins[peak_idx]

    return cfo_hz


def apply_cfo_correction(iq: np.ndarray, cfo_hz: float, fs: float) -> np.ndarray:
    """应用频偏补偿"""
    n = np.arange(len(iq))
    correction = np.exp(-1j * 2 * np.pi * cfo_hz / fs * n)
    return iq * correction


def plot_cfo_analysis(iq_orig: np.ndarray, iq_corrected: np.ndarray,
                      cfo_hz: float, fs: float, save_path: str = None):
    """CFO 分析可视化"""
    fig, axes = plt.subplots(2, 2, figsize=(12, 8))

    # 原始星座图
    axes[0, 0].plot(iq_orig.real, iq_orig.imag, '.', markersize=1, alpha=0.5)
    axes[0, 0].set_title(f'Before Correction (CFO={cfo_hz:.1f} Hz)')
    axes[0, 0].set_xlabel('I'); axes[0, 0].set_ylabel('Q')
    axes[0, 0].set_aspect('equal'); axes[0, 0].grid(True, alpha=0.3)

    # 校正后星座图
    axes[0, 1].plot(iq_corrected.real, iq_corrected.imag, '.', markersize=1, alpha=0.5)
    axes[0, 1].set_title('After Correction')
    axes[0, 1].set_xlabel('I'); axes[0, 1].set_ylabel('Q')
    axes[0, 1].set_aspect('equal'); axes[0, 1].grid(True, alpha=0.3)

    # 相位随时间变化
    phase = np.unwrap(np.angle(iq_orig * np.conj(iq_corrected)))
    t = np.arange(len(phase)) / fs * 1e6
    axes[1, 0].plot(t[::100], phase[::100])
    axes[1, 0].set_xlabel('Time (μs)'); axes[1, 0].set_ylabel('Phase (rad)')
    axes[1, 0].set_title('Phase Accumulation Over Time')
    axes[1, 0].grid(True, alpha=0.3)

    # 频谱对比
    f = np.fft.fftfreq(min(2048, len(iq_orig)), 1/fs) / 1e6
    spec_orig = 20 * np.log10(np.abs(np.fft.fft(iq_orig[:2048])) + 1e-12)
    spec_corr = 20 * np.log10(np.abs(np.fft.fft(iq_corrected[:2048])) + 1e-12)
    axes[1, 1].plot(f[:1024], spec_orig[:1024] - np.max(spec_orig), label='Original')
    axes[1, 1].plot(f[:1024], spec_corr[:1024] - np.max(spec_corr), label='Corrected')
    axes[1, 1].set_xlabel('Frequency (MHz)'); axes[1, 1].set_ylabel('PSD (dB)')
    axes[1, 1].set_title('Spectrum Comparison')
    axes[1, 1].legend(); axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    if save_path:
        plt.savefig(save_path, dpi=150)
    plt.show()


def main():
    parser = argparse.ArgumentParser(description='频偏估计与补偿工具')
    parser.add_argument('--file', '-f', required=True, help='IQ 数据文件')
    parser.add_argument('--fs', type=float, required=True,
                        help='采样率 (Hz)')
    parser.add_argument('--method', choices=['cp', 'lts', 'fft'],
                        default='cp', help='估计方法')
    parser.add_argument('--fft-size', type=int, default=2048,
                        help='FFT 尺寸 (CP 方法)')
    parser.add_argument('--cp-len', type=int, default=144,
                        help='CP 长度 (CP 方法)')
    parser.add_argument('--out', '-o', default=None, help='输出图片路径')
    args = parser.parse_args()

    iq = load_iq(args.file)
    print(f"Loaded {len(iq)} samples from {args.file}, fs={args.fs/1e6:.2f}MHz")

    # 频偏估计
    if args.method == 'cp':
        norm_cfo = estimate_cfo_cp(iq, args.fft_size, args.cp_len)
    elif args.method == 'lts':
        norm_cfo = estimate_cfo_lts(iq, 64)
    else:
        cfo_hz = estimate_cfo_fft(iq, args.fs)
        norm_cfo = cfo_hz / 15e3  # 相对子载波间隔

    cfo_hz = norm_cfo * 15e3  # 转 Hz (对 OFDM, 子载波间隔=15kHz)
    print(f"Estimated CFO: {norm_cfo:.6f} (×子载波间隔) = {cfo_hz:.1f} Hz")

    # 补偿
    iq_corrected = apply_cfo_correction(iq, cfo_hz, args.fs)

    # 可视化
    plot_cfo_analysis(iq, iq_corrected, cfo_hz, args.fs, args.out)


if __name__ == '__main__':
    main()
