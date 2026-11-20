#!/usr/bin/env python3
"""
EVM 计算与分析模板

用途: 计算误差向量幅度 (EVM)，评估调制质量
支持: QPSK/16QAM/64QAM/256QAM

用法:
    python evm_calc.py --ref ref.csv --meas meas.csv --mod 256qam
    python evm_calc.py --file rx_iq.bin --mod 64qam --sym 1000
    python evm_calc.py --ref ref.csv --meas meas.csv --per-sc --fft-size 2048
"""

import argparse
import json
import numpy as np
import matplotlib.pyplot as plt


def load_iq(filepath: str) -> np.ndarray:
    """加载 IQ 数据"""
    ext = filepath.lower().rsplit('.', 1)[-1]
    if ext in ('csv', 'txt'):
        data = np.loadtxt(filepath, delimiter=',')
        if data.ndim == 1:
            data = data.reshape(-1, 2)
        return data[:, 0] + 1j * data[:, 1]
    elif ext == 'bin':
        raw = np.fromfile(filepath, dtype=np.int16)
        return (raw[0::2] + 1j * raw[1::2]).astype(np.complex64)
    elif ext == 'npy':
        return np.load(filepath)
    else:
        raise ValueError(f"Unknown format: {ext}")


def generate_ref_constellation(num_symbols: int, modulation: str) -> np.ndarray:
    """生成理想星座点参考信号"""
    if modulation.lower() == 'qpsk':
        bits = np.random.randint(0, 2, num_symbols * 2)
        ref = (2*bits[0::2]-1 + 1j*(2*bits[1::2]-1)) / np.sqrt(2)
    elif modulation.lower() == '16qam':
        bits = np.random.randint(0, 2, num_symbols * 4)
        i_map = np.array([-3, -1, 1, 3]) / np.sqrt(10)
        q_map = np.array([-3, -1, 1, 3]) / np.sqrt(10)
        ref = i_map[bits[0::4]*2 + bits[1::4]] + 1j * q_map[bits[2::4]*2 + bits[3::4]]
    elif modulation.lower() == '64qam':
        # 简写: 64QAM 星座图
        i_vals = np.array([-7, -5, -3, -1, 1, 3, 5, 7]) / np.sqrt(42)
        q_vals = np.array([-7, -5, -3, -1, 1, 3, 5, 7]) / np.sqrt(42)
        bits = np.random.randint(0, 2, num_symbols * 6)
        i_idx = bits[0::6]*4 + bits[1::6]*2 + bits[2::6]
        q_idx = bits[3::6]*4 + bits[4::6]*2 + bits[5::6]
        ref = i_vals[i_idx] + 1j * q_vals[q_idx]
    elif modulation.lower() == '256qam':
        i_vals = np.array([-15,-13,-11,-9,-7,-5,-3,-1,1,3,5,7,9,11,13,15]) / np.sqrt(170)
        q_vals = np.array([-15,-13,-11,-9,-7,-5,-3,-1,1,3,5,7,9,11,13,15]) / np.sqrt(170)
        bits = np.random.randint(0, 2, num_symbols * 8)
        i_idx = bits[0::8]*8 + bits[1::8]*4 + bits[2::8]*2 + bits[3::8]
        q_idx = bits[4::8]*8 + bits[5::8]*4 + bits[6::8]*2 + bits[7::8]
        ref = i_vals[i_idx] + 1j * q_vals[q_idx]
    else:
        raise ValueError(f"Unsupported modulation: {modulation}")
    return ref


def calculate_evm(meas: np.ndarray, ref: np.ndarray) -> dict:
    """
    计算 EVM 指标

    Returns:
        dict with keys: evm_rms, evm_peak, evm_percent, mag_error, phase_error
    """
    # 确保长度一致
    min_len = min(len(meas), len(ref))
    meas = meas[:min_len]
    ref = ref[:min_len]

    # 归一化 (功率对齐)
    scale = np.sqrt(np.mean(np.abs(ref)**2) / np.mean(np.abs(meas)**2))
    meas_norm = meas * scale

    # 误差向量
    error = meas_norm - ref

    # EVM RMS
    evm_rms = np.sqrt(np.mean(np.abs(error)**2) / np.mean(np.abs(ref)**2))

    # EVM Peak
    evm_peak = np.max(np.abs(error) / np.abs(ref))

    # 幅度/相位误差
    mag_error = np.abs(meas_norm) - np.abs(ref)
    phase_error = np.angle(meas_norm * np.conj(ref))

    return {
        'evm_rms': evm_rms,
        'evm_rms_percent': evm_rms * 100,
        'evm_peak': evm_peak,
        'evm_peak_percent': evm_peak * 100,
        'num_symbols': min_len,
        'mean_mag_error': np.mean(np.abs(mag_error)),
        'mean_phase_error_deg': np.mean(np.abs(phase_error)) * 180 / np.pi,
        'error_vector': error,
        'meas_normalized': meas_norm,
    }


def evm_per_subcarrier(iq_meas: np.ndarray, iq_ref: np.ndarray,
                       fft_size: int = 2048) -> np.ndarray:
    """
    计算每个子载波的 EVM (OFDM 信号)

    Returns: 每子载波 EVM 数组 (长度 = fft_size/2)
    """
    # OFDM 解调
    n_sym = min(len(iq_meas), len(iq_ref)) // fft_size

    evm_sc = np.zeros(fft_size // 2)
    count_sc = np.zeros(fft_size // 2)

    for i in range(n_sym):
        meas_sym = np.fft.fft(iq_meas[i*fft_size:(i+1)*fft_size])
        ref_sym = np.fft.fft(iq_ref[i*fft_size:(i+1)*fft_size])

        error = meas_sym - ref_sym
        evm_sc += np.abs(error[:fft_size//2])**2 / np.abs(ref_sym[:fft_size//2])**2
        count_sc += 1

    return np.sqrt(evm_sc / count_sc) * 100


def plot_evm_report(evm_result: dict, modulation: str,
                    evm_per_sc: np.ndarray = None, save_path: str = None):
    """EVM 报告可视化"""
    fig = plt.figure(figsize=(14, 10))

    # 1. 星座图 (左上)
    ax1 = fig.add_subplot(2, 2, 1)
    meas = evm_result['meas_normalized']
    ax1.plot(meas.real, meas.imag, '.', markersize=1, alpha=0.5)
    ax1.set_title(f'Constellation (EVM={evm_result["evm_rms_percent"]:.2f}%)')
    ax1.set_xlabel('I'); ax1.set_ylabel('Q')
    ax1.set_aspect('equal'); ax1.grid(True, alpha=0.3)

    # 2. 误差向量分布 (右上)
    ax2 = fig.add_subplot(2, 2, 2)
    error = evm_result['error_vector']
    ax2.hist(np.abs(error) * 100, bins=50, alpha=0.7)
    ax2.axvline(evm_result['evm_rms_percent'], color='r', linestyle='--',
                label=f'RMS={evm_result["evm_rms_percent"]:.2f}%')
    ax2.axvline(evm_result['evm_peak_percent'], color='orange', linestyle='--',
                label=f'Peak={evm_result["evm_peak_percent"]:.2f}%')
    ax2.set_xlabel('Error Magnitude (%)')
    ax2.set_ylabel('Count')
    ax2.set_title('Error Vector Distribution')
    ax2.legend(); ax2.grid(True, alpha=0.3)

    # 3. 每子载波 EVM (左下)
    ax3 = fig.add_subplot(2, 2, 3)
    if evm_per_sc is not None:
        ax3.plot(evm_per_sc, linewidth=0.5)
        ax3.axhline(3.5, color='r', linestyle='--', label='256QAM Limit')
        ax3.set_xlabel('Subcarrier Index')
        ax3.set_ylabel('EVM (%)')
        ax3.set_title('EVM per Subcarrier')
        ax3.legend(); ax3.grid(True, alpha=0.3)

    # 4. Summary 文本 (右下)
    ax4 = fig.add_subplot(2, 2, 4)
    ax4.axis('off')
    summary = (
        f"EVM 分析报告\n"
        f"{'='*25}\n"
        f"调制方式: {modulation.upper()}\n"
        f"符号数: {evm_result['num_symbols']}\n"
        f"{'─'*25}\n"
        f"RMS EVM:  {evm_result['evm_rms_percent']:.3f}%\n"
        f"Peak EVM: {evm_result['evm_peak_percent']:.3f}%\n"
        f"{'─'*25}\n"
        f"平均幅度误差: {evm_result['mean_mag_error']:.5f}\n"
        f"平均相位误差: {evm_result['mean_phase_error_deg']:.3f}°\n"
    )
    if evm_per_sc is not None:
        summary += f"{'─'*25}\n"
        summary += f"最大 SC EVM: {np.max(evm_per_sc):.2f}%\n"
        summary += f"最小 SC EVM: {np.min(evm_per_sc):.2f}%\n"
    ax4.text(0.1, 0.9, summary, fontsize=11, fontfamily='monospace',
             verticalalignment='top',
             bbox=dict(boxstyle='round', facecolor='wheat', alpha=0.5))

    plt.tight_layout()
    if save_path:
        plt.savefig(save_path, dpi=150)
        print(f"EVM 报告已保存: {save_path}")
    plt.show()


def main():
    parser = argparse.ArgumentParser(description='EVM 计算与分析工具')
    parser.add_argument('--ref', help='参考 IQ 文件')
    parser.add_argument('--meas', help='测量 IQ 文件')
    parser.add_argument('--file', help='单文件模式 (仅测量, 自动生成参考)')
    parser.add_argument('--mod', default='256qam',
                        help='调制方式 (qpsk/16qam/64qam/256qam)')
    parser.add_argument('--sym', type=int, default=5000,
                        help='参考符号数 (file 模式)')
    parser.add_argument('--per-sc', action='store_true',
                        help='分析每子载波 EVM')
    parser.add_argument('--fft-size', type=int, default=2048,
                        help='FFT 尺寸 (per-sc 模式)')
    parser.add_argument('--out', '-o', default=None, help='输出图片路径')
    parser.add_argument('--json', action='store_true',
                        help='输出 JSON 格式结果')
    args = parser.parse_args()

    # 加载数据
    if args.file:
        meas = load_iq(args.file)
        ref = generate_ref_constellation(len(meas), args.mod)
    else:
        meas = load_iq(args.meas)
        if args.ref:
            ref = load_iq(args.ref)
        else:
            ref = generate_ref_constellation(len(meas), args.mod)

    print(f"Loaded {len(meas)} measured symbols, {len(ref)} ref symbols")

    # EVM 计算
    evm = calculate_evm(meas, ref)

    print(f"\nEVM Results ({args.mod.upper()}):")
    print(f"  RMS EVM:  {evm['evm_rms_percent']:.3f}%")
    print(f"  Peak EVM: {evm['evm_peak_percent']:.3f}%")

    # 阈值检查
    limits = {'qpsk': 17.5, '16qam': 12.5, '64qam': 8, '256qam': 3.5}
    if args.mod.lower() in limits:
        limit = limits[args.mod.lower()]
        status = '✅ PASS' if evm['evm_rms_percent'] < limit else '❌ FAIL'
        print(f"  Limit: {limit}% → {status}")

    # 每子载波 EVM
    evm_sc = None
    if args.per_sc:
        evm_sc = evm_per_subcarrier(meas, ref, args.fft_size)
        print(f"  Max SC EVM: {np.max(evm_sc):.2f}%")
        print(f"  Min SC EVM: {np.min(evm_sc):.2f}%")

    # 输出
    if args.json:
        result = {k: v for k, v in evm.items()
                  if not isinstance(v, np.ndarray)}
        print(json.dumps(result, indent=2))

    # 可视化
    plot_evm_report(evm, args.mod, evm_sc, args.out)


if __name__ == '__main__':
    main()
