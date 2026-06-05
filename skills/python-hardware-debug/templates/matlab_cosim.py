#!/usr/bin/env python3
"""
MATLAB↔Python 协同仿真脚本

在 Python 环境中调用 MATLAB Golden Model，生成激励向量，
然后用 Python 分析工具完成星座图绘制、EVM 计算、频谱分析，
最后与 RTL 仿真输出进行对比。

两种运行模式:
  Mode 1 — Engine API: 直接调用 matlab.engine (需安装 MATLAB Engine for Python)
  Mode 2 — 文件模式:   通过 subprocess 调用 MATLAB 脚本, 读取生成的文件

用法:
    # Engine 模式: 运行指定算法的 golden model + Python 分析
    python matlab_cosim.py --algo ofdm --engine

    # 文件模式: 运行 MATLAB 脚本后独立分析生成的向量
    python matlab_cosim.py --algo rrc --matlab-script golden/src/generate_vectors.m

    # 对比 RTL 输出
    python matlab_cosim.py --algo ofdm --rtl-output rtl_output.bin

    # 完整流程: golden → 仿真 → 对比
    python matlab_cosim.py --algo ofdm --engine --sim --compare

依赖:
    numpy, matplotlib, scipy
    matlabengine (pip install matlabengine)  # Engine 模式需要
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Optional, Tuple, Dict, Any

import numpy as np
import matplotlib.pyplot as plt


# ============================================================================
# 数据加载 — 通用向量读取
# ============================================================================

def load_expected_tx(bin_path: str, scale: float = 1.0) -> np.ndarray:
    """
    加载黄金向量 expected_tx.bin (Q2.14 或 Q3.13 格式)

    Format: 每行 32-bit hex, {Q[15:0], I[15:0]}
    scale: 定点缩放因子 (Q2.14=16384, Q3.13=8192)

    Returns: 复数 IQ (float64)
    """
    raw = np.fromfile(bin_path, dtype=np.uint32)
    i_part = (raw & 0xFFFF).astype(np.int16)
    q_part = ((raw >> 16) & 0xFFFF).astype(np.int16)
    iq = i_part.astype(np.float64) / scale + 1j * q_part.astype(np.float64) / scale
    return iq


def load_rtl_output(bin_path: str, scale: float = 1.0) -> np.ndarray:
    """加载 RTL 仿真输出 rtl_output.bin (同 packed 格式)"""
    return load_expected_tx(bin_path, scale)


def load_iq_csv(filepath: str) -> np.ndarray:
    """从 CSV 加载 IQ 数据 (两列: I, Q)"""
    data = np.loadtxt(filepath, delimiter=',')
    if data.ndim == 1:
        data = data.reshape(-1, 2)
    return data[:, 0] + 1j * data[:, 1]


# ============================================================================
# MATLAB 引擎接口
# ============================================================================

class MatlabEngine:
    """MATLAB Engine 封装 — 支持直接调用和文件模式两种后端"""

    def __init__(self, use_engine: bool = True, matlab_root: Optional[str] = None):
        self.use_engine = use_engine
        self.matlab_root = matlab_root
        self._engine = None

    def _start_engine(self):
        """启动 MATLAB Engine"""
        if self._engine is not None:
            return
        try:
            import matlab.engine
            if self.matlab_root:
                self._engine = matlab.engine.start_matlab(
                    '-desktop' if os.name == 'nt' else '',
                    option=['-sd', self.matlab_root]
                )
            else:
                self._engine = matlab.engine.start_matlab()
            print(f"[MATLAB] Engine started (version: {self._engine.version()})")
        except ImportError:
            print("[MATLAB] matlabengine not installed, falling back to file mode")
            self.use_engine = False
        except Exception as e:
            print(f"[MATLAB] Engine start failed: {e}, falling back to file mode")
            self.use_engine = False

    def run_script(self, script_path: str, working_dir: Optional[str] = None) -> str:
        """
        运行 MATLAB 脚本

        Args:
            script_path: .m 文件路径
            working_dir: 工作目录 (脚本所在目录)

        Returns: stdout 输出
        """
        if self.use_engine:
            self._start_engine()
            if self._engine:
                if working_dir:
                    self._engine.cd(working_dir)
                output = self._engine.run(Path(script_path).stem, nargout=1)
                if output:
                    print(f"[MATLAB] Output: {output}")
                return str(output or "")

        # Fallback: file mode
        return self._run_matlab_subprocess(script_path, working_dir)

    def run_function(self, func_name: str, *args) -> Any:
        """直接调用 MATLAB 函数 (Engine 模式)"""
        if not self.use_engine or not self._engine:
            raise RuntimeError("Engine not started, use run_script() instead")
        return self._engine.feval(func_name, *args)

    @staticmethod
    def _run_matlab_subprocess(script_path: str, working_dir: Optional[str] = None) -> str:
        """通过 subprocess 调用 MATLAB (无 Engine)"""
        script_path = Path(script_path).resolve()
        wd = working_dir or str(script_path.parent)

        if os.name == 'nt':  # Windows
            cmd = [
                'matlab',
                '-batch',
                f"cd('{wd}'); run('{script_path.name}'); exit;"
            ]
        else:  # Linux
            cmd = [
                'matlab',
                '-batch',
                f"cd('{wd}'); run('{script_path.name}'); exit;"
            ]

        try:
            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=300
            )
            if result.returncode != 0:
                print(f"[MATLAB] Error (rc={result.returncode}): {result.stderr}")
            print(f"[MATLAB] stdout: {result.stdout[:500]}...")
            return result.stdout or ""
        except subprocess.TimeoutExpired:
            print("[MATLAB] Timeout (300s)")
            return ""
        except FileNotFoundError:
            print("[MATLAB] MATLAB not found in PATH. Install or add to PATH.")
            return ""

    def close(self):
        """关闭 Engine"""
        if self._engine:
            self._engine.quit()
            self._engine = None
            print("[MATLAB] Engine stopped")

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


# ============================================================================
# 分析函数
# ============================================================================

def calc_evm(measured: np.ndarray, reference: np.ndarray) -> Dict[str, float]:
    """
    计算 EVM (Error Vector Magnitude)

    Returns:
        dict: rms_evm_pct, peak_evm_pct, max_error, mse
    """
    if len(measured) != len(reference):
        min_len = min(len(measured), len(reference))
        measured = measured[:min_len]
        reference = reference[:min_len]

    # 功率归一化
    ref_power = np.mean(np.abs(reference) ** 2)
    if ref_power < 1e-12:
        ref_power = 1.0

    error = measured - reference
    error_power = np.abs(error) ** 2

    rms_evm = np.sqrt(np.mean(error_power) / ref_power) * 100
    peak_evm = np.sqrt(np.max(error_power) / ref_power) * 100
    max_abs_error = np.max(np.abs(error))
    mse = np.mean(error_power)

    return {
        'rms_evm_pct': rms_evm,
        'peak_evm_pct': peak_evm,
        'max_error': max_abs_error,
        'mse': mse,
        'num_samples': len(measured)
    }


def analyze_spectrum(iq: np.ndarray, fs: float = 30.72e6) -> Dict[str, Any]:
    """频谱分析 — 功率谱密度, 带外抑制估计"""
    from scipy import signal as sp_signal

    f, psd = sp_signal.periodogram(iq, fs=fs, return_onesided=False)
    f = np.fft.fftshift(f)
    psd = np.fft.fftshift(psd)
    psd_db = 10 * np.log10(psd + 1e-12)

    # 信号带宽 (3dB)
    peak_idx = np.argmax(psd)
    half_power = psd[peak_idx] / 2
    above_half = np.where(psd >= half_power)[0]
    bw = (f[above_half[-1]] - f[above_half[0]]) if len(above_half) > 1 else 0.0

    # ACLR 估计 (邻道功率比)
    total_power = np.sum(psd)
    in_band = np.sum(psd[above_half])
    aclr_db = 10 * np.log10((total_power - in_band) / (in_band + 1e-12))

    return {
        'bandwidth_hz': bw,
        'aclr_db': aclr_db,
        'peak_power_db': np.max(psd_db),
        'dynamic_range_db': np.max(psd_db) - np.min(psd_db)
    }


# ============================================================================
# 报告与可视化
# ============================================================================

def generate_report(
        golden: np.ndarray,
        rtl: Optional[np.ndarray] = None,
        evm_result: Optional[Dict] = None,
        algo_name: str = "unknown",
        output_dir: str = "."
) -> str:
    """
    生成 cosim 报告 (文本 + 截图)

    Returns: 报告文本路径
    """
    report_lines = [
        "=" * 60,
        f"  MATLAB↔RTL Co-Simulation Report",
        f"  Algorithm: {algo_name.upper()}",
        f"  Samples:   {len(golden)}",
        "=" * 60,
        "",
    ]

    if evm_result:
        report_lines += [
            "  [EVM Analysis]",
            f"    RMS EVM:     {evm_result['rms_evm_pct']:.4f} %",
            f"    Peak EVM:    {evm_result['peak_evm_pct']:.4f} %",
            f"    Max Error:   {evm_result['max_error']:.6f}",
            f"    MSE:         {evm_result['mse']:.10f}",
            "",
        ]

    if rtl is not None:
        # 对比 golden vs rtl
        diff = rtl - golden
        max_diff = np.max(np.abs(diff))
        rms_diff = np.sqrt(np.mean(np.abs(diff) ** 2))

        report_lines += [
            "  [Golden vs RTL]",
            f"    Max |Diff|:  {max_diff:.6f}",
            f"    RMS Diff:    {rms_diff:.6f}",
            f"    SNR(est):    {20 * np.log10(1.0 / (rms_diff + 1e-12)):.2f} dB",
            f"    Match Rate:  {np.sum(np.abs(diff) < 1e-3) / len(diff) * 100:.2f} %",
            "",
        ]

        # 波形对比图
        fig, axes = plt.subplots(3, 1, figsize=(12, 8))

        n_plot = min(200, len(golden))
        idx = np.arange(n_plot)

        axes[0].plot(idx, golden[:n_plot].real, 'b-', label='Golden I', alpha=0.7)
        axes[0].plot(idx, rtl[:n_plot].real, 'r--', label='RTL I', alpha=0.7)
        axes[0].set_ylabel('I')
        axes[0].legend()
        axes[0].grid(True, alpha=0.3)
        axes[0].set_title(f'{algo_name.upper()} — Golden vs RTL (I)')

        axes[1].plot(idx, golden[:n_plot].imag, 'b-', label='Golden Q', alpha=0.7)
        axes[1].plot(idx, rtl[:n_plot].imag, 'r--', label='RTL Q', alpha=0.7)
        axes[1].set_ylabel('Q')
        axes[1].legend()
        axes[1].grid(True, alpha=0.3)
        axes[1].set_title(f'{algo_name.upper()} — Golden vs RTL (Q)')

        axes[2].plot(idx, diff[:n_plot].real, 'g-', label='Diff I', alpha=0.7)
        axes[2].plot(idx, diff[:n_plot].imag, 'm-', label='Diff Q', alpha=0.7)
        axes[2].set_ylabel('Difference')
        axes[2].set_xlabel('Sample Index')
        axes[2].legend()
        axes[2].grid(True, alpha=0.3)
        axes[2].set_title(f'Difference (RMS={rms_diff:.6f})')

        plt.tight_layout()
        plot_path = os.path.join(output_dir, f'{algo_name}_cosim_waveform.png')
        plt.savefig(plot_path, dpi=150)
        plt.close()
        report_lines.append(f"  Waveform plot: {plot_path}")

        # 星座图对比
        fig, axes = plt.subplots(1, 2, figsize=(12, 5))
        for ax, data, title in zip(
                axes, [golden, rtl],
                [f'{algo_name.upper()} Golden', f'{algo_name.upper()} RTL']
        ):
            n_plot_c = min(5000, len(data))
            idx_c = np.random.choice(len(data), n_plot_c, replace=False) if len(data) > n_plot_c else slice(None)
            ax.plot(data[idx_c].real, data[idx_c].imag, '.', markersize=1, alpha=0.5)
            ax.set_title(title)
            ax.set_xlabel('I')
            ax.set_ylabel('Q')
            ax.set_aspect('equal')
            ax.grid(True, alpha=0.3)
        plt.tight_layout()
        const_path = os.path.join(output_dir, f'{algo_name}_cosim_constellation.png')
        plt.savefig(const_path, dpi=150)
        plt.close()
        report_lines.append(f"  Constellation plot: {const_path}")

    report_path = os.path.join(output_dir, f'{algo_name}_cosim_report.txt')
    with open(report_path, 'w') as f:
        f.write('\n'.join(report_lines))

    print('\n'.join(report_lines))
    print(f"\nReport saved: {report_path}")
    return report_path


# ============================================================================
# 算法配置表
# ============================================================================

ALGO_CONFIG = {
    'ofdm': {
        'name': 'OFDM Transmitter',
        'golden_dir': 'knowledge/primary/domains/comm/ofdm/golden_model',
        'script': 'generate_vectors.m',
        'expected_bin': 'expected_tx.bin',
        'scale': 8192,  # Q3.13
        'mod_types': ['qpsk', '16qam', '64qam'],
    },
    'rrc': {
        'name': 'RRC Filter',
        'golden_dir': 'knowledge/primary/domains/comm/rrc/golden_model',
        'script': 'generate_vectors.m',
        'expected_bin': 'expected_tx.bin',
        'scale': 16384,  # Q2.14
        'mod_types': ['qpsk', '16qam'],
    },
    'chEst': {
        'name': 'Channel Estimator',
        'golden_dir': 'knowledge/primary/domains/comm/channel_est/golden_model',
        'script': 'generate_vectors.m',
        'expected_bin': 'expected_chEst.bin',
        'scale': 16384,  # Q2.14
        'mod_types': ['ls_linear', 'ls_dft'],
    },
    'sync': {
        'name': 'Synchronization',
        'golden_dir': 'knowledge/primary/domains/comm/synch/golden_model',
        'script': 'generate_vectors.m',
        'expected_bin': 'expected_sync_out.bin',
        'scale': 16384,  # Q2.14
    },
}


# ============================================================================
# 主流程
# ============================================================================

def run_cosim(args: argparse.Namespace) -> int:
    """执行协同仿真主逻辑"""

    # 查找算法配置
    algo = args.algo
    if algo not in ALGO_CONFIG:
        available = ', '.join(ALGO_CONFIG.keys())
        print(f"Unknown algorithm '{algo}'. Available: {available}")
        return 1

    cfg = ALGO_CONFIG[algo]

    # 确定项目根目录 (向上查找 knowledge/)
    script_dir = Path(__file__).resolve().parent
    # 从 template 目录向上找 knowledge/
    knowledge_root = None
    for candidate in [
        script_dir.parents[4],  # 假设在 skills/python-hardware-debug/templates/
        script_dir.parents[3],
        Path.cwd(),
    ]:
        if (candidate / 'knowledge' / 'INDEX.md').exists():
            knowledge_root = candidate / 'knowledge'
            break

    if knowledge_root is None:
        print("[ERROR] Cannot find knowledge/ root. Run from project directory.")
        return 1

    # Run MATLAB golden model
    if args.engine or args.matlab_script:
        golden_dir = knowledge_root / cfg['golden_dir'] / 'src'
        script_path = golden_dir / cfg['script']

        if not script_path.exists():
            print(f"[ERROR] MATLAB script not found: {script_path}")
            return 1

        print(f"\n{'=' * 60}")
        print(f"  Algorithm: {cfg['name']} ({args.algo})")
        print(f"  Mode:      {'Engine' if args.engine else 'File'} mode")
        print(f"  Script:    {script_path}")
        print(f"{'=' * 60}\n")

        matlab = MatlabEngine(use_engine=args.engine)
        matlab.run_script(str(script_path), working_dir=str(golden_dir))
        matlab.close()

    # Load golden vectors
    golden_dir_path = knowledge_root / cfg['golden_dir'] / 'src'
    expected_path = golden_dir_path / cfg['expected_bin']

    if not expected_path.exists():
        print(f"[ERROR] Golden vector not found: {expected_path}")
        print("  Run with --engine or --matlab-script to generate first.")
        return 1

    print(f"\nLoading golden vector: {expected_path}")
    golden = load_expected_tx(str(expected_path), cfg['scale'])
    print(f"  {len(golden)} samples loaded")

    # Optional: load RTL output
    rtl = None
    if args.rtl_output:
        rtl_path = Path(args.rtl_output)
        if rtl_path.exists():
            print(f"Loading RTL output: {rtl_path}")
            rtl = load_rtl_output(str(rtl_path), cfg['scale'])
            print(f"  {len(rtl)} samples loaded")
        else:
            print(f"[WARN] RTL output not found: {rtl_path}")

    # Run EVM analysis
    evm_ref = rtl if rtl is not None else golden
    evm_result = calc_evm(golden, evm_ref)

    print(f"\n  RMS EVM:  {evm_result['rms_evm_pct']:.4f} %")
    print(f"  Peak EVM: {evm_result['peak_evm_pct']:.4f} %")

    # Spectrum analysis
    if args.spectrum:
        fs = args.fs
        spec = analyze_spectrum(golden, fs)
        print(f"\n  Bandwidth: {spec['bandwidth_hz'] / 1e6:.2f} MHz")
        print(f"  ACLR:      {spec['aclr_db']:.1f} dB")

    # Constellation plot
    if args.plot:
        fig, ax = plt.subplots(1, 1, figsize=(8, 8))
        n_plot = min(5000, len(golden))
        idx = np.random.choice(len(golden), n_plot, replace=False)
        ax.plot(golden[idx].real, golden[idx].imag, '.', markersize=1, alpha=0.5)
        ax.set_title(f'{cfg["name"]} — Constellation ({args.algo})')
        ax.set_xlabel('I')
        ax.set_ylabel('Q')
        ax.set_aspect('equal')
        ax.grid(True, alpha=0.3)
        plt.tight_layout()
        plt.show()

    # Generate report
    if args.report:
        output_dir = args.output or '.'
        os.makedirs(output_dir, exist_ok=True)
        generate_report(golden, rtl, evm_result, args.algo, output_dir)

    # Print CLI integration hint
    if not args.quiet:
        print(f"\n{'─' * 60}")
        print(f"  Tip: pipe analysis to other templates:")
        print(f"    python constellation.py --file {expected_path} --fmt bin")
        print(f"    python evm_calc.py --ref {expected_path} --meas <rtl_output.bin>")
        print(f"{'─' * 60}")

    return 0


def main():
    parser = argparse.ArgumentParser(
        description='MATLAB↔Python Co-Simulation for FPGA Algorithm Verification',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # 完整流程: golden → 分析 → 报告
  python matlab_cosim.py --algo ofdm --engine --plot --report --output ./cosim_out

  # 仅分析已有向量
  python matlab_cosim.py --algo rrc --plot --spectrum --fs 30.72e6

  # 对比 RTL 输出
  python matlab_cosim.py --algo ofdm --rtl-output ./sim/rtl_output.bin --report
        """
    )

    parser.add_argument('--algo', required=True,
                        choices=list(ALGO_CONFIG.keys()),
                        help='算法名称')
    parser.add_argument('--engine', action='store_true',
                        help='使用 MATLAB Engine API (需要 matlabengine Python 包)')
    parser.add_argument('--matlab-script', type=str, default=None,
                        help='直接指定 MATLAB 脚本路径')
    parser.add_argument('--rtl-output', type=str, default=None,
                        help='RTL 仿真输出文件路径 (rtl_output.bin)')
    parser.add_argument('--plot', action='store_true',
                        help='显示星座图')
    parser.add_argument('--spectrum', action='store_true',
                        help='频谱分析 (需要 scipy)')
    parser.add_argument('--report', action='store_true',
                        help='生成 HTML/文本报告')
    parser.add_argument('--output', '-o', type=str, default=None,
                        help='输出目录')
    parser.add_argument('--fs', type=float, default=30.72e6,
                        help='采样率 (Hz, 仅频谱分析时使用)')
    parser.add_argument('--quiet', '-q', action='store_true',
                        help='静默模式')
    parser.add_argument('--sim', action='store_true',
                        help='运行 RTL 仿真 (需要 Vivado xsim)')
    parser.add_argument('--compare', action='store_true',
                        help='执行 golden vs RTL 对比')

    args = parser.parse_args()

    # --sim 和 --compare 是占位提示, RTL 仿真需单独流程
    if args.sim:
        print("[INFO] RTL simulation not integrated yet. Use project's sim script.")
        print("  e.g., cd sim && vsim -c -do run_sim.tcl")
    if args.compare:
        if not args.rtl_output:
            print("[ERROR] --compare requires --rtl-output <file>")
            return 1

    return run_cosim(args)


if __name__ == '__main__':
    sys.exit(main())
