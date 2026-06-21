#!/usr/bin/env python3
"""
Resource Estimator — RTL 资源一阶估算工具

在 Phase 1b (B1/B2/B3) 环节使用，根据架构参数快速估算：
  - DSP48 / LUT / BRAM 消耗
  - Fmax 预判
  - 与预算对比（超 10% 告警）
  - 时序风险标注

用法:
  python resource_estimator.py --module fir --taps 16 --data_width 16 --fold 2 --target_fmax 200

  python resource_estimator.py --module cmult --data_width 16 --arch 3-dsp

  python resource_estimator.py --module fifo --depth 512 --data_width 32 --media bram

  python resource_estimator.py --module cdc --type async_fifo --depth 16 --f_wr 200 --f_rd 100

  python resource_estimator.py --report design.yaml   (从 YAML 读整个系统)

输出格式:
  JSON (stdout)，同时打印人类可读摘要。

数据来源:
  Xilinx 7-series / UltraScale+ 典型值 (一阶估算, ±30%)
"""
import argparse
import json
import sys
import math
from dataclasses import dataclass, field, asdict
from typing import Optional

# ── 数据模型 ─────────────────────────────────────────────────────────────────

@dataclass
class ResourceEstimate:
    module: str
    arch: str
    dsp48: int = 0
    lut: int = 0
    ff: int = 0
    bram18k: int = 0
    bram36k: int = 0
    latency_cycles: int = 0
    throughput_samp_per_cyc: float = 1.0
    fmax_mhz_est: str = "中"          # 高/中/低
    fmax_mhz_range: str = "150-300"   # 范围
    timing_risks: list = field(default_factory=list)
    budget_check: str = "N/A"

@dataclass
class Budget:
    dsp48: int = 0
    lut: int = 0
    bram18k: int = 0
    bram36k: int = 0

# ── 估算函数 ──────────────────────────────────────────────────────────────────

def estimate_fir(taps: int, data_width: int, fold: int, arch: str = "auto",
                 target_fmax: float = 0, budget: Optional[Budget] = None) -> ResourceEstimate:
    """FIR 滤波器资源估算

    架构选择:
      - fully_parallel: N DSP48, 1 cyc/tap
      - semi_folded_K2: N/2 DSP48, 2 cyc   (fold=2)
      - semi_folded_K4: N/4 DSP48, 4 cyc   (fold=4)
      - serial: 1 DSP48, N cyc
      - systolic: N DSP48, N cyc, higher Fmax

    对称 FIR 可利用 pre-adder: DSP48 = ceil(N/2)
    """
    if arch == "auto":
        if fold >= taps:
            arch = "serial"
        elif fold >= taps / 2:
            arch = "semi_folded_K4"
        elif fold >= taps / 4:
            arch = "semi_folded_K2"
        else:
            arch = "fully_parallel"

    is_symmetric = False  # 可在参数中控制

    est = ResourceEstimate(module="fir", arch=arch)

    if arch == "fully_parallel":
        n_dsp = taps if not is_symmetric else (taps + 1) // 2
        adder_tree_levels = math.ceil(math.log2(taps))
        lut_adder = 40 * adder_tree_levels
        est.dsp48 = n_dsp
        est.lut = 250 + lut_adder
        est.ff = 20 * taps + 40 * adder_tree_levels
        est.latency_cycles = 1 + adder_tree_levels  # 乘法 + 加法树
        est.throughput_samp_per_cyc = 1.0
        est.fmax_mhz_est = "中"
        est.fmax_mhz_range = "150-250"

    elif arch == "semi_folded_K2":
        n_dsp = (taps + 1) // 2 if not is_symmetric else (taps + 3) // 4
        est.dsp48 = n_dsp
        est.lut = 150 + 30 * 2 + 20 * math.ceil(math.log2(n_dsp))
        est.ff = 15 * taps + 50
        est.latency_cycles = 2 + math.ceil(math.log2(n_dsp))
        est.throughput_samp_per_cyc = 0.5
        est.fmax_mhz_est = "中高"
        est.fmax_mhz_range = "200-300"

    elif arch == "semi_folded_K4":
        n_dsp = (taps + 3) // 4 if not is_symmetric else (taps + 7) // 8
        est.dsp48 = n_dsp
        est.lut = 120 + 30 * 4 + 20 * math.ceil(math.log2(n_dsp))
        est.ff = 15 * taps + 50
        est.latency_cycles = 4 + math.ceil(math.log2(n_dsp))
        est.throughput_samp_per_cyc = 0.25
        est.fmax_mhz_est = "中"
        est.fmax_mhz_range = "150-250"

    elif arch == "serial":
        est.dsp48 = 1
        est.lut = 80 + 20 * math.ceil(math.log2(taps))
        est.ff = 25 + 2 * taps
        est.latency_cycles = taps + 2
        est.throughput_samp_per_cyc = 1.0 / taps
        est.fmax_mhz_est = "高"
        est.fmax_mhz_range = "250-400"

    elif arch == "systolic":
        est.dsp48 = taps
        est.lut = 250 + 30 * math.ceil(math.log2(taps))
        est.ff = 20 * taps + 40 * math.ceil(math.log2(taps))
        est.latency_cycles = taps + 2
        est.throughput_samp_per_cyc = 1.0
        est.fmax_mhz_est = "高"
        est.fmax_mhz_range = "250-350"

    # Fmax 检查
    if target_fmax > 0:
        min_fmax = int(est.fmax_mhz_range.split("-")[0])
        if target_fmax > min_fmax * 1.5:  # 超过上限 50%
            est.timing_risks.append(
                f"⚠️ target_fmax={target_fmax}MHz > {est.fmax_mhz_range}MHz typical for {arch}"
            )

    # 资源预算检查
    if budget:
        items = [
            ("DSP48", est.dsp48, budget.dsp48),
            ("LUT", est.lut, budget.lut),
        ]
        violations = []
        for name, used, total in items:
            if total > 0 and used > total:
                ratio = used / total * 100
                violations.append(f"❌ {name}: {used} > {total} ({ratio:.0f}%)")
            elif total > 0 and used > total * 1.1:
                ratio = used / total * 100
                violations.append(f"⚠️ {name}: {used}/{total} ({ratio:.0f}%) — 超 10%")
            elif total > 0:
                ratio = used / total * 100
                violations.append(f"✅ {name}: {used}/{total} ({ratio:.0f}%)")
        if violations:
            est.budget_check = "\n      ".join(violations)
        else:
            est.budget_check = "✅ 在预算内" if budget.dsp48 > 0 or budget.lut > 0 else "N/A"

    return est


def estimate_cordic(iterations: int, data_width: int, arch: str = "pipelined",
                    target_fmax: float = 0, budget: Optional[Budget] = None) -> ResourceEstimate:
    """CORDIC 资源估算

    arch:
      - iterative: 1 stage reused N times → small area, N+2 cycles
      - pipelined: N stages → large area, 1 cycle throughput
      - hybrid_K2: N/2 stages, K=2 iterations/stage
      - hybrid_K4: N/4 stages, K=4 iterations/stage
    """
    est = ResourceEstimate(module="cordic", arch=arch)
    lut_per_stage = 250 + 40 * data_width
    reg_per_stage = 150 * data_width

    if arch == "iterative":
        n_stages = 1
        est.lut = lut_per_stage + 50 * data_width
        est.ff = reg_per_stage
        est.dsp48 = 0
        est.latency_cycles = iterations + 2
        est.throughput_samp_per_cyc = 1.0 / (iterations + 2)
        est.fmax_mhz_est = "高"
        est.fmax_mhz_range = "250-400"

    elif arch == "pipelined":
        n_stages = iterations
        est.lut = lut_per_stage * iterations + 50 * data_width
        est.ff = reg_per_stage * iterations
        est.dsp48 = 0
        est.latency_cycles = iterations
        est.throughput_samp_per_cyc = 1.0
        est.fmax_mhz_est = "中"
        est.fmax_mhz_range = "150-250"

    elif arch.startswith("hybrid"):
        try:
            k = int(arch.split("_K")[1]) if "_K" in arch else 2
        except (IndexError, ValueError):
            k = 2
        n_stages = math.ceil(iterations / k)
        est.lut = lut_per_stage * n_stages + 50 * data_width
        est.ff = reg_per_stage * n_stages
        est.dsp48 = 0
        est.latency_cycles = n_stages + 2
        est.throughput_samp_per_cyc = 1.0 / n_stages if n_stages > 1 else 1.0
        est.fmax_mhz_est = "中高"
        est.fmax_mhz_range = "200-300"

    if budget:
        items = [
            ("LUT", est.lut, budget.lut),
        ]
        violations = []
        for name, used, total in items:
            if total > 0 and used > total:
                violations.append(f"❌ {name}: {used} > {total} ({used/total*100:.0f}%)")
            elif total > 0 and used > total * 1.1:
                violations.append(f"⚠️ {name}: {used}/{total} ({used/total*100:.0f}%) — 超 10%")
        if violations:
            est.budget_check = "\n      ".join(violations)
        else:
            est.budget_check = "✅ 在预算内"

    return est


def estimate_cmult(data_width: int, arch: str = "3-dsp",
                   target_fmax: float = 0, budget: Optional[Budget] = None) -> ResourceEstimate:
    """复乘 (Complex Multiplier) 资源估算

    arch:
      - 4-dsp: 4 mult + 2 add
      - 3-dsp: 3 mult + 5 add (复用 ac, bd)
      - 1-dsp: time-shared
      - lut: 查表实现 (仅小位宽)
    """
    est = ResourceEstimate(module="cmult", arch=arch)

    if arch == "4-dsp":
        est.dsp48 = 4
        est.lut = 30
        est.ff = 8 * data_width
        est.latency_cycles = 2
        est.fmax_mhz_est = "高"
        est.fmax_mhz_range = "250-350"

    elif arch == "3-dsp":
        est.dsp48 = 3
        est.lut = 50
        est.ff = 10 * data_width
        est.latency_cycles = 3
        est.fmax_mhz_est = "高"
        est.fmax_mhz_range = "250-350"

    elif arch == "1-dsp":
        est.dsp48 = 1
        est.lut = 80
        est.ff = 12 * data_width
        est.latency_cycles = 4
        est.throughput_samp_per_cyc = 0.25
        est.fmax_mhz_est = "中高"
        est.fmax_mhz_range = "200-300"

    elif arch == "lut":
        lut_table = data_width * data_width // 2 * 2  # 实部+虚部
        est.dsp48 = 0
        est.lut = lut_table + 50
        est.ff = 4 * data_width
        est.latency_cycles = 1
        est.fmax_mhz_est = "高"
        est.fmax_mhz_range = "200-350"
        est.timing_risks.append(f"LUT-only 复乘在位宽 > 8 时面积大: LUT≈{lut_table}")

    if budget:
        for item in [("DSP48", est.dsp48, budget.dsp48), ("LUT", est.lut, budget.lut)]:
            name, used, total = item
            if total > 0 and used > total:
                est.timing_risks.append(f"❌ {name}: {used} > {total}")
            elif total > 0 and used > total * 1.1:
                est.timing_risks.append(f"⚠️ {name}: {used}/{total} ({used/total*100:.0f}%) — 超 10%")

    return est


def estimate_fft(n_point: int, data_width: int, arch: str = "r2sdf",
                 target_fmax: float = 0, budget: Optional[Budget] = None) -> ResourceEstimate:
    """FFT 资源估算

    arch:
      - r2sdf: Radix-2 Single-path Delay Feedback
      - r22sdf: Radix-2^2 SDF (乘法器更少)
      - r4sdf: Radix-4 SDF
      - r2mdc: Radix-2 Multi-path Delay Commutator
    """
    est = ResourceEstimate(module="fft", arch=arch)
    stages = math.ceil(math.log2(n_point))

    if arch == "r2sdf":
        # 每级 2 复乘 (3-DSP each = 6 DSP)
        est.dsp48 = stages * 6
        est.lut = 500 + 100 * stages
        est.ff = 800 + 150 * stages
        # 延迟 RAM: N/2 samples × 2 (实+虚)
        bram_bits = (n_point // 2) * data_width * 2
        est.bram18k = max(1, math.ceil(bram_bits / 18000))
        est.latency_cycles = n_point // 2 + stages
        est.fmax_mhz_est = "中"
        est.fmax_mhz_range = "150-250"
        # 旋转因子 ROM
        twiddle_entries = n_point // 2
        twiddle_bits = twiddle_entries * data_width * 2
        est.bram18k += max(0, math.ceil(twiddle_bits / 18000) - 1)

    elif arch == "r22sdf":
        # 每级 2 复乘 (但结构优化, 乘法器更少)
        est.dsp48 = stages * 4  # 比 R2SDF 少
        est.lut = 550 + 120 * stages
        est.ff = 850 + 160 * stages
        bram_bits = (n_point // 2) * data_width * 2
        est.bram18k = max(1, math.ceil(bram_bits / 18000))
        est.latency_cycles = n_point // 2 + stages
        est.fmax_mhz_est = "中"
        est.fmax_mhz_range = "150-250"

    elif arch == "r4sdf":
        n_stages = math.ceil(math.log(n_point, 4))
        # 每级 3 复乘
        est.dsp48 = n_stages * 9
        est.lut = 600 + 200 * n_stages
        est.ff = 900 + 180 * n_stages
        bram_bits = (n_point // 4) * data_width * 2
        est.bram18k = max(1, math.ceil(bram_bits / 18000))
        est.latency_cycles = n_point // 4 + n_stages
        est.fmax_mhz_est = "中"
        est.fmax_mhz_range = "150-250"

    elif arch == "r2mdc":
        est.dsp48 = stages * 12  # 2 路并行, 每路 6 DSP
        est.lut = 800 + 200 * stages
        est.ff = 1200 + 250 * stages
        bram_bits = (n_point // 2) * data_width * 4
        est.bram18k = max(2, math.ceil(bram_bits / 18000))
        est.latency_cycles = n_point // 4 + stages
        est.throughput_samp_per_cyc = 2.0
        est.fmax_mhz_est = "中低"
        est.fmax_mhz_range = "120-200"
        est.timing_risks.append("R2MDC 控制复杂, 建议首选用 R2SDF")

    if budget:
        for item in [("DSP48", est.dsp48, budget.dsp48),
                     ("BRAM18K", est.bram18k, budget.bram18k)]:
            name, used, total = item
            if total > 0 and used > total:
                est.budget_check += f"❌ {name}: {used} > {total}  "
            elif total > 0 and used > total * 1.1:
                est.budget_check += f"⚠️ {name}: {used}/{total} ({used/total*100:.0f}%)  "

    return est


def estimate_fifo(depth: int, data_width: int, media: str = "auto",
                  is_async: bool = False, f_wr: float = 0, f_rd: float = 0,
                  budget: Optional[Budget] = None) -> ResourceEstimate:
    """FIFO 资源估算

    media:
      - reg: register-based (深度 ≤ 16)
      - lutram: distributed RAM (深度 ≤ 64)
      - bram: Block RAM
      - auto: 根据深度自动选择
    """
    if media == "auto":
        if depth <= 16:
            media = "reg"
        elif depth <= 64:
            media = "lutram"
        else:
            media = "bram"

    est = ResourceEstimate(module="fifo", arch=f"{'async_' if is_async else ''}{media}")
    est.latency_cycles = 3 if is_async else 1
    est.throughput_samp_per_cyc = 1.0

    if media == "reg":
        est.lut = 4 * depth * data_width // 6 + 50
        est.ff = depth * data_width + 50
        est.bram18k = 0
        est.fmax_mhz_est = "高"
        est.fmax_mhz_range = "250-400"

    elif media == "lutram":
        est.lut = math.ceil(depth * data_width / 6) + 100
        est.ff = 80
        est.bram18k = 0
        est.fmax_mhz_est = "高"
        est.fmax_mhz_range = "200-350"

    elif media == "bram":
        est.lut = 100
        est.ff = 60
        est.bram18k = math.ceil(depth * data_width / 18000)
        est.fmax_mhz_est = "中"
        est.fmax_mhz_range = "150-250"

    if is_async:
        if f_wr > 0 and f_rd > 0 and f_wr > f_rd:
            burst = depth  # 假设满深度为 burst 长度
            min_depth = burst * (1 - f_rd / f_wr) + 4
            if depth < min_depth:
                est.timing_risks.append(
                    f"⚠️ 异步 FIFO 深度 {depth} < 推荐 {min_depth:.0f} "
                    f"(f_wr={f_wr}MHz, f_rd={f_rd}MHz, burst={burst})"
                )
        if depth < 4:
            est.timing_risks.append("❌ 异步 FIFO 深度 < 4, 格雷码无法正常编解码")

    if budget:
        for item in [("BRAM18K", est.bram18k, budget.bram18k),
                     ("LUT", est.lut, budget.lut)]:
            name, used, total = item
            if total > 0 and used > total:
                est.budget_check += f"❌ {name}: {used} > {total}  "
            elif total > 0 and used > total * 1.1:
                est.budget_check += f"⚠️ {name}: {used}/{total} ({used/total*100:.0f}%)  "

    return est


def estimate_mac(inputs: int, data_width: int, is_complex: bool = False,
                 budget: Optional[Budget] = None) -> ResourceEstimate:
    """MAC / 向量 MAC 资源估算"""
    est = ResourceEstimate(module="mac",
                           arch=f"{'complex_' if is_complex else ''}vector_mac_{inputs}")
    est.latency_cycles = 2
    est.throughput_samp_per_cyc = 1.0
    est.fmax_mhz_est = "高"
    est.fmax_mhz_range = "250-350"

    if is_complex:
        est.dsp48 = 3 * inputs
        est.lut = 50 * inputs
        est.ff = 10 * data_width * inputs
    else:
        est.dsp48 = inputs
        est.lut = 30 * inputs
        est.ff = 8 * data_width * inputs

    if budget:
        for item in [("DSP48", est.dsp48, budget.dsp48),
                     ("LUT", est.lut, budget.lut)]:
            name, used, total = item
            if total > 0 and used > total:
                est.budget_check += f"❌ {name}: {used} > {total}  "

    return est


def estimate_pipeline(reg_type: str = "reg_slice", data_width: int = 32,
                      stages: int = 1, budget: Optional[Budget] = None) -> ResourceEstimate:
    """Pipeline 寄存器资源估算

    reg_type:
      - reg_slice: valid-ready pipeline register
      - skid_buffer: 2-entry FIFO-like
      - fifo: synchronous FIFO depth=stages
    """
    est = ResourceEstimate(module="pipeline", arch=f"{reg_type}(W={data_width})")

    if reg_type == "reg_slice":
        est.lut = 30 * stages
        est.ff = 70 * stages
        est.latency_cycles = stages
        est.fmax_mhz_est = "高"
        est.fmax_mhz_range = "300-400"

    elif reg_type == "skid_buffer":
        est.lut = 80 * stages
        est.ff = 100 * stages
        est.latency_cycles = 0  # FWFT
        est.fmax_mhz_est = "高"
        est.fmax_mhz_range = "250-350"

    return est


# ── YAML 系统级估算 ──────────────────────────────────────────────────────────

def estimate_from_yaml(yaml_content: str, budget: Optional[Budget] = None) -> list:
    """从 YAML 内容解析系统架构并逐模块估算

    YAML 格式:
      target_fmax: 200
      budget:
        dsp48: 200
        lut: 80000
        bram18k: 100
      modules:
        - name: rx_fir
          type: fir
          taps: 32
          data_width: 16
          fold: 2
        - name: freq_est
          type: cordic
          iterations: 16
          data_width: 16
          arch: pipelined
        - name: fft_64
          type: fft
          n_point: 64
          data_width: 16
          arch: r2sdf
        - name: data_buffer
          type: fifo
          depth: 512
          data_width: 32
        - name: twiddle_mult
          type: cmult
          data_width: 16
          arch: 3-dsp
    """
    import yaml
    try:
        config = yaml.safe_load(yaml_content)
    except Exception as e:
        return [ResourceEstimate(module="parse_error", arch=str(e),
                                  timing_risks=[f"YAML 解析失败: {e}"])]

    if not config or "modules" not in config:
        return [ResourceEstimate(module="error", arch="no_modules",
                                  timing_risks=["YAML 中未找到 modules 定义"])]

    target_fmax = config.get("target_fmax", 0)
    yaml_budget_data = config.get("budget", {})
    yaml_budget = Budget(
        dsp48=yaml_budget_data.get("dsp48", 0),
        lut=yaml_budget_data.get("lut", 0),
        bram18k=yaml_budget_data.get("bram18k", 0),
    )
    if budget:
        yaml_budget = budget

    results = []
    for mod in config["modules"]:
        mod_type = mod.get("type", "").lower()
        name = mod.get("name", "unnamed")
        mod_budget = Budget(dsp48=0, lut=0, bram18k=0)
        if yaml_budget.dsp48 > 0:
            mod_budget.dsp48 = yaml_budget.dsp48
            yaml_budget.dsp48 -= mod.get("dsp48", 0)

        if mod_type == "fir":
            r = estimate_fir(
                taps=mod.get("taps", 16),
                data_width=mod.get("data_width", 16),
                fold=mod.get("fold", 1),
                arch=mod.get("arch", "auto"),
                target_fmax=mod.get("target_fmax", target_fmax),
            )
        elif mod_type == "cordic":
            r = estimate_cordic(
                iterations=mod.get("iterations", 16),
                data_width=mod.get("data_width", 16),
                arch=mod.get("arch", "pipelined"),
                target_fmax=mod.get("target_fmax", target_fmax),
            )
        elif mod_type == "cmult":
            r = estimate_cmult(
                data_width=mod.get("data_width", 16),
                arch=mod.get("arch", "3-dsp"),
            )
        elif mod_type == "fft":
            r = estimate_fft(
                n_point=mod.get("n_point", 64),
                data_width=mod.get("data_width", 16),
                arch=mod.get("arch", "r2sdf"),
            )
        elif mod_type == "fifo":
            r = estimate_fifo(
                depth=mod.get("depth", 64),
                data_width=mod.get("data_width", 32),
                media=mod.get("media", "auto"),
                is_async=mod.get("is_async", False),
                f_wr=mod.get("f_wr", 0),
                f_rd=mod.get("f_rd", 0),
            )
        elif mod_type == "mac":
            r = estimate_mac(
                inputs=mod.get("inputs", 1),
                data_width=mod.get("data_width", 16),
                is_complex=mod.get("is_complex", False),
            )
        else:
            r = ResourceEstimate(module=name, arch="unknown",
                                  timing_risks=[f"未知模块类型: {mod_type}"])
        r.module = name
        results.append(r)

    return results


# ── 输出格式化 ────────────────────────────────────────────────────────────────

def print_summary(est: ResourceEstimate):
    """打印人类可读的估算摘要"""
    print(f"\n{'='*60}")
    print(f"  {est.module.upper()} [{est.arch}]")
    print(f"{'='*60}")
    print(f"  DSP48: {est.dsp48}  |  LUT: {est.lut}  |  FF: {est.ff}")
    print(f"  BRAM18K: {est.bram18k}  |  BRAM36K: {est.bram36k}")
    print(f"  延迟: {est.latency_cycles} cyc  |  吞吐: {est.throughput_samp_per_cyc} samp/cyc")
    print(f"  Fmax 范围: {est.fmax_mhz_range} MHz ({est.fmax_mhz_est})")

    if est.budget_check and est.budget_check != "N/A":
        print(f"  预算对照:")
        for line in est.budget_check.split("\n"):
            print(f"    {line.strip()}")

    if est.timing_risks:
        print(f"  ⚠️ 时序风险:")
        for risk in est.timing_risks:
            print(f"    {risk}")

    print(f"{'='*60}\n")


def print_json(estimates: list):
    """输出 JSON"""
    print(json.dumps(
        [asdict(e) for e in estimates],
        indent=2,
        ensure_ascii=False
    ))


# ── YAML 兼容 — 简易 import ─────────────────────────────────────────────────

def _simple_yaml_load(text):
    """加载简单的 YAML (仅 key: value 和 - list, 无嵌套复杂结构)"""
    import re
    result = {}
    lines = text.strip().split("\n")
    current_key = None
    current_list = []
    indent_stack = []

    for line in lines:
        if not line.strip() or line.strip().startswith("#"):
            continue
        stripped = line.lstrip()
        indent = len(line) - len(stripped)

        if stripped.startswith("- "):
            item_text = stripped[2:]
            current_list.append(item_text.strip())
        elif ":" in stripped:
            key, _, value = stripped.partition(":")
            current_list = []
            if value.strip():
                result[key.strip()] = value.strip()
            else:
                current_key = key.strip()
                result[current_key] = {}

    return result


# ── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="RTL 资源一阶估算器 (Xilinx 7-series / UltraScale+)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  # FIR 滤波器 (全并行 32 taps, 16-bit)
  python resource_estimator.py --module fir --taps 32 --data_width 16

  # FIR 半折叠 (fold=2)
  python resource_estimator.py --module fir --taps 32 --data_width 16 --fold 2

  # CORDIC 流水线 (16 迭代)
  python resource_estimator.py --module cordic --iterations 16 --arch pipelined

  # FFT R2SDF (64 点)
  python resource_estimator.py --module fft --n_point 64 --arch r2sdf

  # FIFO (BRAM, 512 深度, 32 位宽)
  python resource_estimator.py --module fifo --depth 512 --data_width 32

  # 异步 FIFO (检查深度够不够)
  python resource_estimator.py --module fifo --depth 16 --data_width 32 --f_wr 200 --f_rd 100

  # 从 YAML 读整个系统
  python resource_estimator.py --report system.yaml

  # 带预算检查
  python resource_estimator.py --module fir --taps 64 --data_width 16 --budget_dsp48 30 --budget_lut 2000
"""
    )

    # 通用参数
    parser.add_argument("--module", type=str, default="",
                        choices=["", "fir", "cordic", "cmult", "fft", "fifo", "mac", "pipeline"],
                        help="模块类型")
    parser.add_argument("--data_width", type=int, default=16, help="数据位宽")
    parser.add_argument("--target_fmax", type=float, default=0, help="目标 Fmax (MHz)")
    parser.add_argument("--budget_dsp48", type=int, default=0, help="DSP48 预算")
    parser.add_argument("--budget_lut", type=int, default=0, help="LUT 预算")
    parser.add_argument("--budget_bram18k", type=int, default=0, help="BRAM18K 预算")
    parser.add_argument("--json", action="store_true", help="仅输出 JSON")
    parser.add_argument("--report", type=str, default="", help="从 YAML 文件读系统配置")

    # FIR
    parser.add_argument("--taps", type=int, default=16, help="FIR tap 数")
    parser.add_argument("--fold", type=int, default=1, help="FIR 折叠系数")

    # CORDIC
    parser.add_argument("--iterations", type=int, default=16, help="CORDIC 迭代次数")
    parser.add_argument("--arch", type=str, default="auto",
                        help="架构 (fully_parallel/semi_folded_K2/serial/pipelined/iterative/3-dsp/r2sdf/reg/lutram/bram)")

    # FFT
    parser.add_argument("--n_point", type=int, default=64, help="FFT 点数")

    # FIFO
    parser.add_argument("--depth", type=int, default=64, help="FIFO 深度")
    parser.add_argument("--media", type=str, default="auto", help="存储介质 (reg/lutram/bram)")
    parser.add_argument("--f_wr", type=float, default=0, help="写时钟频率 (MHz, CDC 检查用)")
    parser.add_argument("--f_rd", type=float, default=0, help="读时钟频率 (MHz, CDC 检查用)")

    args = parser.parse_args()

    budget = Budget(
        dsp48=args.budget_dsp48,
        lut=args.budget_lut,
        bram18k=args.budget_bram18k,
    )

    # ── YAML 报告模式 ─────────────────────────────────────────────────
    if args.report:
        with open(args.report, "r") as f:
            content = f.read()
        estimates = estimate_from_yaml(content, budget)
        if args.json:
            print_json(estimates)
        else:
            print(f"\n{'#'*60}")
            print(f"# 系统级资源估算: {args.report}")
            print(f"{'#'*60}")
            total = ResourceEstimate(module="TOTAL", arch="system")
            for e in estimates:
                print_summary(e)
                total.dsp48 += e.dsp48
                total.lut += e.lut
                total.ff += e.ff
                total.bram18k += e.bram18k
            print(f"\n{'='*60}")
            print(f"  系统合计:")
            print(f"  DSP48: {total.dsp48}  LUT: {total.lut}  FF: {total.ff}  BRAM18K: {total.bram18k}")
            print(f"{'='*60}")
        return

    # ── 单模块模式 ────────────────────────────────────────────────────
    if not args.module:
        parser.print_help()
        sys.exit(1)

    arch = args.arch
    if arch == "auto":
        arch = "auto"

    if args.module == "fir":
        est = estimate_fir(args.taps, args.data_width, args.fold, arch,
                           args.target_fmax, budget)
    elif args.module == "cordic":
        est = estimate_cordic(args.iterations, args.data_width, arch,
                              args.target_fmax, budget)
    elif args.module == "cmult":
        est = estimate_cmult(args.data_width, arch, args.target_fmax, budget)
    elif args.module == "fft":
        est = estimate_fft(args.n_point, args.data_width, arch,
                           args.target_fmax, budget)
    elif args.module == "fifo":
        is_async = args.f_wr > 0 or args.f_rd > 0
        est = estimate_fifo(args.depth, args.data_width, args.media,
                            is_async, args.f_wr, args.f_rd, budget)
    elif args.module == "mac":
        est = estimate_mac(args.taps, args.data_width, False, budget)
    elif args.module == "pipeline":
        est = estimate_pipeline(arch, args.data_width, args.taps, budget)
    else:
        print(f"未知模块类型: {args.module}")
        sys.exit(1)

    if args.json:
        print_json([est])
    else:
        print_summary(est)

    # 如果有风险，非零退出码（供 CI/脚本检测）
    if est.timing_risks:
        sys.exit(2)  # exit 2 = 有风险需关注


if __name__ == "__main__":
    main()
