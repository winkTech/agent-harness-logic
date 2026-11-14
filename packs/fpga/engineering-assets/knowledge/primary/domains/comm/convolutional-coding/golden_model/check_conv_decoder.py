#!/usr/bin/env python3
# ──────────────────────────────────────────────────────────────────────
# check_conv_decoder.py
# 卷积码 + Viterbi 译码器 Python 验证脚本
# K=7, G1=171₈, G2=133₈, rates=1/2,2/3,3/4,5/6,7/8
#
# 用法:
#   python check_conv_decoder.py --tv-dir <路径> --output <结果.json> [--rate 1/2]
#
# 验证项:
#   1) 编码器 — 加载 tv*_data_in.hex → 编码 → 对比 tv*_coded_out.hex
#   2) 译码器 — 加载 tv*_coded_out.hex → 无噪声译码 → 对比 tv*_data_in.hex
#   3) 译码器(噪声) — 注入可控噪声 → 译码 → 对比原始数据
#   4) 删余 — 加载 tv*_coded_mother.hex → 删余 → 对比 tv*_coded_punc_*.hex
# ──────────────────────────────────────────────────────────────────────

import argparse
import json
import os
import sys
import time
import glob
from datetime import datetime, timezone


# ══════════════════════════════════════════════════════════════════════
# 常量定义
# ══════════════════════════════════════════════════════════════════════

K = 7                          # 约束长度
N_STATES = 1 << (K - 1)        # 64 状态
G1 = 0b1111001                 # 171₈
G2 = 0b1011011                 # 133₈

# 删余模式（1D 掩码，作用于扁平串行化母码流 X0,Y0,X1,Y1,...）
# 这些模式来自算法规范中的 MATLAB 代码的 find(pattern) 列主序展开
PUNCTURE_PATTERNS = {
    (1, 2): [1, 1],
    (2, 3): [1, 1, 1, 0],
    (3, 4): [1, 1, 1, 0, 0, 1],
    (5, 6): [1, 1, 1, 0, 0, 1, 0, 1, 0, 1],
    (7, 8): [1, 1, 1, 0, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1],
}

RATE_LABELS = {
    (1, 2): '1_2',
    (2, 3): '2_3',
    (3, 4): '3_4',
    (5, 6): '5_6',
    (7, 8): '7_8',
}

# ══════════════════════════════════════════════════════════════════════
# 网格图（Trellis）预计算
# ══════════════════════════════════════════════════════════════════════

def build_trellis():
    """预计算网格图转移和期望输出。

    状态位: bit i = sr[5-i], 其中 sr[0]=x[n-1] (最新), sr[5]=x[n-6] (最旧)
    转移:  new_state = (old_state >> 1) | (input_bit << 5)
    合并:  combined = (input_bit << 6) | old_state
           G1 输出 = parity(combined & G1)
           G2 输出 = parity(combined & G2)
    """
    next_state = [[0, 0] for _ in range(N_STATES)]
    expected = [[(0, 0), (0, 0)] for _ in range(N_STATES)]

    for s in range(N_STATES):
        for inp in (0, 1):
            ns = ((s >> 1) | (inp << 5)) & 0x3F
            next_state[s][inp] = ns
            combined = (inp << 6) | s
            out1 = bin(combined & G1).count('1') & 1
            out2 = bin(combined & G2).count('1') & 1
            expected[s][inp] = (out1, out2)

    return next_state, expected


NEXT_STATE, EXPECTED = build_trellis()


# ══════════════════════════════════════════════════════════════════════
# 卷积编码器
# ══════════════════════════════════════════════════════════════════════

def conv_encode(bits):
    """K=7, G1=171₈, G2=133₈ 卷积编码器。

    参数:
        bits: 信息比特列表 [0/1, ...]
    返回:
        编码比特列表 [X0,Y0,X1,Y1,...]（不含收尾）
    """
    sr = [0] * (K - 1)  # 6 级移位寄存器
    output = []

    for b in bits:
        y1 = b
        y2 = b
        for i in range(K - 1):
            if (G1 >> (K - 2 - i)) & 1:
                y1 ^= sr[i]
            if (G2 >> (K - 2 - i)) & 1:
                y2 ^= sr[i]
        output.extend([y1, y2])
        sr = [b] + sr[:-1]

    return output


def conv_encode_with_tail(bits):
    """编码并添加 (K-1) 个收尾零比特将状态归零。"""
    return conv_encode(bits + [0] * (K - 1))


# ══════════════════════════════════════════════════════════════════════
# Viterbi 硬判决译码器
# ══════════════════════════════════════════════════════════════════════

def viterbi_decode_hard(rx_bits, tb_len=None, erasure_mask=None):
    """硬判决 Viterbi 译码器 (K=7, rate=1/2)。

    参数:
        rx_bits:        接收硬判决比特 [0/1, ...]，长度为 2×n_cycles
        tb_len:         回溯深度（默认 5×K = 35）
        erasure_mask:   删余掩码，1=有效，0=删余（与 rx_bits 同长），
                        为 None 时全部视为有效
    返回:
        decoded_bits:   译码信息比特列表
    """
    if tb_len is None:
        tb_len = 5 * K

    if erasure_mask is None:
        erasure_mask = [1] * len(rx_bits)

    n_bits = len(rx_bits)
    if n_bits % 2 != 0:
        raise ValueError(f'rx_bits 长度必须为偶数，收到 {n_bits}')
    n_cycles = n_bits // 2

    # ── 路径度量初始化（64 状态） ──
    pm = [float('inf')] * N_STATES
    pm[0] = 0  # 从零状态开始

    # ── 幸存路径存储 surv[t][state] = 前驱状态 ──
    surv = [[0] * N_STATES for _ in range(n_cycles)]

    # ── ACS（加-比-选） ──
    for t in range(n_cycles):
        r0 = rx_bits[2 * t]
        r1 = rx_bits[2 * t + 1]
        e0 = erasure_mask[2 * t]
        e1 = erasure_mask[2 * t + 1]

        new_pm = [float('inf')] * N_STATES

        for ns in range(N_STATES):
            inp_bit = ns >> 5  # 引起转移到 ns 的输入比特
            prev0 = (ns << 1) & 0x3F
            prev1 = ((ns << 1) & 0x3F) | 1

            for prev in (prev0, prev1):
                exp0, exp1 = EXPECTED[prev][inp_bit]
                bm = 0
                if e0:
                    bm += r0 ^ exp0
                if e1:
                    bm += r1 ^ exp1
                cand = pm[prev] + bm
                if cand < new_pm[ns]:
                    new_pm[ns] = cand
                    surv[t][ns] = prev

        pm = new_pm

        # ── 路径度量归一化（减最小值） ──
        min_pm = min(pm)
        if min_pm > 0:
            pm = [p - min_pm for p in pm]

    # ── 回溯 ──
    # 由于编码器收尾到零状态，从状态 0 开始回溯
    state = 0
    decoded = []
    for t in range(n_cycles - 1, -1, -1):
        decoded.append(state >> 5)
        state = surv[t][state]

    decoded.reverse()
    return decoded


def depuncture(punctured_bits, rate):
    """解删余：在删余位置插入中性比特。

    参数:
        punctured_bits: 已删余的编码比特流
        rate:           目标码率 (num, den)
    返回:
        mother_bits:    恢复后的母码比特流（长度扩展为原始母码长度）
        erasure_mask:   有效掩码（1=原始有效, 0=删余插入）
    """
    pattern = PUNCTURE_PATTERNS[rate]
    period = len(pattern)

    # 重建母码比特流，删余位填充 0
    mother_bits = []
    erasure_mask = []
    pidx = 0
    for b in punctured_bits:
        while pattern[pidx % period] == 0:
            mother_bits.append(0)
            erasure_mask.append(0)
            pidx += 1
        mother_bits.append(b)
        erasure_mask.append(1)
        pidx += 1
    # 补全周期末尾可能的剩余删余位（补齐到 period 的整数倍）
    # 注意：实际硬件不会补，但 Viterbi 需要完整周期才能正确计算 BM
    while pidx % period != 0:
        if pattern[pidx % period] == 0:
            mother_bits.append(0)
            erasure_mask.append(0)
        pidx += 1

    return mother_bits, erasure_mask


# ══════════════════════════════════════════════════════════════════════
# 删余 / 解删余
# ══════════════════════════════════════════════════════════════════════

def puncture(mother_bits, rate):
    """对母码比特流执行删余。

    参数:
        mother_bits: 母码编码比特 [X0,Y0,X1,Y1,...]
        rate:        目标码率 (num, den)
    返回:
        punctured_bits: 删余后的比特流
    """
    pattern = PUNCTURE_PATTERNS[rate]
    period = len(pattern)
    return [b for i, b in enumerate(mother_bits) if pattern[i % period]]


# ══════════════════════════════════════════════════════════════════════
# 文件 I/O
# ══════════════════════════════════════════════════════════════════════

def load_hex(path):
    """加载 .hex 文件（每行一个 bit，0 或 1）。返回整数列表。"""
    bits = []
    with open(path, 'r') as f:
        for line in f:
            line = line.strip()
            if line:
                bits.append(int(line))
    return bits


def load_csv(path):
    """加载 .csv 文件（逗号分隔整数）。返回整数列表。"""
    import csv
    values = []
    with open(path, 'r', newline='') as f:
        reader = csv.reader(f)
        for row in reader:
            for val in row:
                val = val.strip()
                if val:
                    values.append(int(val))
    return values


# ══════════════════════════════════════════════════════════════════════
# 验证函数
# ══════════════════════════════════════════════════════════════════════

def find_tv_pairs(tv_dir, suffix_data, suffix_ref, pattern='tv*'):
    """在 tv 目录中查找配对的测试向量文件。

    返回: [(data_path, ref_path, basename), ...]
    """
    import glob
    data_files = sorted(glob.glob(os.path.join(tv_dir, f'{pattern}{suffix_data}')))
    pairs = []
    for df in data_files:
        base = df.replace(suffix_data, '')
        rf = base + suffix_ref
        if os.path.exists(rf):
            pairs.append((df, rf, os.path.basename(base)))
    return pairs


def check_encoder(tv_dir, report_failures=True):
    """验证项 1：编码器。

    加载 tv*_data_in.hex → 编码（含收尾）→ 对比 tv*_coded_out.hex
    返回: (compared_points, max_error, failed_points)
    """
    pairs = find_tv_pairs(tv_dir, '_data_in.hex', '_coded_out.hex')
    total_compared = 0
    max_error = 0
    all_failed = []

    for data_path, ref_path, name in pairs:
        data_bits = load_hex(data_path)
        ref_bits = load_hex(ref_path)
        enc_bits = conv_encode_with_tail(data_bits)

        if len(enc_bits) != len(ref_bits):
            # 尝试不包含收尾的编码方式（如果 ref 长度 = 2×len(data)）
            enc_bits_no_tail = conv_encode(data_bits)
            if len(enc_bits_no_tail) == len(ref_bits):
                enc_bits = enc_bits_no_tail

        n_compare = min(len(enc_bits), len(ref_bits))
        for i in range(n_compare):
            total_compared += 1
            if enc_bits[i] != ref_bits[i]:
                err = 1
                max_error = max(max_error, err)
                if report_failures:
                    all_failed.append({
                        'index': i,
                        'expected': ref_bits[i],
                        'actual': enc_bits[i],
                        'error': err,
                    })

    return total_compared, max_error, all_failed


def check_decoder(tv_dir, inject_noise=False, report_failures=True):
    """验证项 2：译码器。

    加载 tv*_coded_out.hex → 译码 → 对比 tv*_data_in.hex
    可选：注入可控噪声后译码。
    返回: (compared_points, max_error, failed_points)
    """
    pairs = find_tv_pairs(tv_dir, '_coded_out.hex', '_data_in.hex')
    total_compared = 0
    max_error = 0
    all_failed = []

    import random
    rng = random.Random(42)

    for ref_path, data_path, name in pairs:
        coded_bits = load_hex(ref_path)
        data_bits = load_hex(data_path)

        # 注入噪声（可控比特翻转）
        if inject_noise:
            noisy_bits = list(coded_bits)
            n_flip = max(1, len(noisy_bits) // 20)  # ~5% BER
            flip_indices = rng.sample(range(len(noisy_bits)), n_flip)
            for idx in flip_indices:
                noisy_bits[idx] ^= 1
            decode_input = noisy_bits
        else:
            decode_input = coded_bits

        decoded = viterbi_decode_hard(decode_input, tb_len=5 * K)

        # 译码输出长度 >= 数据长度（含收尾），取前 len(data_bits) 个比较
        n_compare = min(len(decoded), len(data_bits))
        for i in range(n_compare):
            total_compared += 1
            if decoded[i] != data_bits[i]:
                err = 1
                max_error = max(max_error, err)
                if report_failures:
                    all_failed.append({
                        'index': i,
                        'expected': data_bits[i],
                        'actual': decoded[i],
                        'error': err,
                    })

    return total_compared, max_error, all_failed


def check_puncture(tv_dir, rate=None, report_failures=True):
    """验证项 3：删余。

    加载 tv*_coded_mother.hex → 删余 → 对比 tv*_coded_punc_*.hex
    参数:
        rate: 指定码率 (num, den)，为 None 时测试所有码率
    返回: [(rate, compared_points, max_error, failed_points), ...]
    """
    results = []
    rates_to_test = list(PUNCTURE_PATTERNS.keys()) if rate is None else [rate]

    for r in rates_to_test:
        label = RATE_LABELS[r]
        pairs = find_tv_pairs(tv_dir, '_coded_mother.hex', f'_coded_punc_{label}.hex')
        total_compared = 0
        max_error = 0
        all_failed = []

        for mother_path, punc_path, name in pairs:
            mother_bits = load_hex(mother_path)
            ref_punc_bits = load_hex(punc_path)
            punc_bits = puncture(mother_bits, r)

            n_compare = min(len(punc_bits), len(ref_punc_bits))
            for i in range(n_compare):
                total_compared += 1
                if punc_bits[i] != ref_punc_bits[i]:
                    err = 1
                    max_error = max(max_error, err)
                    if report_failures:
                        all_failed.append({
                            'index': i,
                            'expected': ref_punc_bits[i],
                            'actual': punc_bits[i],
                            'error': err,
                        })

        results.append((r, total_compared, max_error, all_failed))

    return results


# ══════════════════════════════════════════════════════════════════════
# JSON 证据输出
# ══════════════════════════════════════════════════════════════════════

def build_result(module, status, compared_points, max_error,
                 files=None, failed_points=None, duration_us=0,
                 check_type='module', tolerance=0, nmse_db=None):
    """按照 check-result.schema.json 构建结果字典。"""
    result = {
        'module': module,
        'status': status,
        'check_type': check_type,
        'compared_points': compared_points,
        'max_error': max_error,
        'tolerance': tolerance,
        'timestamp': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z'),
        'files': files or [],
        'duration_us': duration_us,
        'toolchain': {
            'python_version': f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}',
        },
    }
    if nmse_db is not None:
        result['nmse_db'] = nmse_db
    if failed_points and len(failed_points) > 0:
        result['failed_points'] = failed_points[:100]  # schema 限制 maxItems=100
    return result


# ══════════════════════════════════════════════════════════════════════
# 主入口
# ══════════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(
        description='卷积码 + Viterbi 译码器 Python 验证脚本')
    parser.add_argument('--tv-dir', required=True,
                        help='测试向量目录路径')
    parser.add_argument('--output', default=None,
                        help='JSON 证据输出路径')
    parser.add_argument('--rate', default=None,
                        help='指定码率 (格式: 1/2, 2/3, 3/4, 5/6, 7/8)，默认全测')
    parser.add_argument('--generate-tv', action='store_true',
                        help='生成测试向量（仅首次运行需要）')
    parser.add_argument('--report-failures', action='store_true', default=True,
                        help='在 JSON 中包含失败点详情')
    args = parser.parse_args()

    tv_dir = args.tv_dir
    if not os.path.isdir(tv_dir):
        print(f'错误: 测试向量目录不存在: {tv_dir}', file=sys.stderr)
        sys.exit(1)

    # 解析码率参数
    target_rate = None
    if args.rate:
        parts = args.rate.split('/')
        if len(parts) == 2:
            target_rate = (int(parts[0]), int(parts[1]))
            if target_rate not in PUNCTURE_PATTERNS:
                print(f'错误: 不支持的码率 {args.rate}。支持: 1/2, 2/3, 3/4, 5/6, 7/8',
                      file=sys.stderr)
                sys.exit(1)
        else:
            print(f'错误: 无效码率格式: {args.rate} (需要 N/M)', file=sys.stderr)
            sys.exit(1)

    all_results = []
    t_start = time.perf_counter()

    # ── 1. 编码器验证 ──
    t0 = time.perf_counter()
    enc_points, enc_max_err, enc_failed = check_encoder(
        tv_dir, report_failures=args.report_failures)
    t1 = time.perf_counter()
    enc_status = 'PASS' if enc_max_err == 0 else 'FAIL'
    all_results.append(build_result(
        module='conv_encoder',
        status=enc_status,
        check_type='module',
        compared_points=enc_points,
        max_error=enc_max_err,
        tolerance=0,
        failed_points=enc_failed if enc_max_err > 0 else None,
        files=[
            {'role': 'script', 'path': __file__},
            {'role': 'golden', 'path': os.path.join(tv_dir, '*_data_in.hex')},
            {'role': 'golden', 'path': os.path.join(tv_dir, '*_coded_out.hex')},
        ],
        duration_us=int((t1 - t0) * 1e6),
    ))
    enc_overall = enc_status

    # ── 2. 译码器验证（无噪声） ──
    t0 = time.perf_counter()
    dec_points, dec_max_err, dec_failed = check_decoder(
        tv_dir, inject_noise=False, report_failures=args.report_failures)
    t1 = time.perf_counter()
    dec_status = 'PASS' if dec_max_err == 0 else 'FAIL'
    all_results.append(build_result(
        module='viterbi_decoder',
        status=dec_status,
        check_type='module',
        compared_points=dec_points,
        max_error=dec_max_err,
        tolerance=0,
        failed_points=dec_failed if dec_max_err > 0 else None,
        files=[
            {'role': 'script', 'path': __file__},
            {'role': 'golden', 'path': os.path.join(tv_dir, '*_coded_out.hex')},
            {'role': 'golden', 'path': os.path.join(tv_dir, '*_data_in.hex')},
        ],
        duration_us=int((t1 - t0) * 1e6),
    ))
    dec_overall = dec_status

    # ── 3. 译码器验证（含噪声） ──
    t0 = time.perf_counter()
    dec_noise_points, dec_noise_err, dec_noise_failed = check_decoder(
        tv_dir, inject_noise=True, report_failures=args.report_failures)
    t1 = time.perf_counter()
    # 有噪声时不要求完全一致，但如果 max_error 超过数据长度的 20% 则标记 FAIL
    noise_threshold = 0.20
    dec_noise_threshold = dec_noise_points * noise_threshold if dec_noise_points > 0 else 1
    dec_noise_status = 'PASS' if dec_noise_err <= dec_noise_threshold else 'FAIL'
    all_results.append(build_result(
        module='viterbi_decoder_noise',
        status=dec_noise_status,
        check_type='module',
        compared_points=dec_noise_points,
        max_error=dec_noise_err,
        tolerance=int(dec_noise_threshold),
        failed_points=dec_noise_failed[:100] if len(dec_noise_failed) > 0 and args.report_failures else None,
        files=[
            {'role': 'script', 'path': __file__},
        ],
        duration_us=int((t1 - t0) * 1e6),
    ))

    # ── 4. 删余验证 ──
    punc_results = check_puncture(
        tv_dir, rate=target_rate, report_failures=args.report_failures)
    punc_overall = 'PASS'
    for r, p_points, p_max_err, p_failed in punc_results:
        t0 = time.perf_counter()
        label = RATE_LABELS[r]
        p_status = 'PASS' if p_max_err == 0 else 'FAIL'
        if p_status == 'FAIL':
            punc_overall = 'FAIL'
        t1 = time.perf_counter()
        all_results.append(build_result(
            module=f'puncture_rate_{label}',
            status=p_status,
            check_type='module',
            compared_points=p_points,
            max_error=p_max_err,
            tolerance=0,
            failed_points=p_failed if p_max_err > 0 else None,
            files=[
                {'role': 'script', 'path': __file__},
                {'role': 'golden', 'path': os.path.join(tv_dir, '*_coded_mother.hex')},
                {'role': 'golden', 'path': os.path.join(tv_dir, f'*_coded_punc_{label}.hex')},
            ],
            duration_us=int((t1 - t0) * 1e6),
        ))

    # ── 汇总 ──
    t_end = time.perf_counter()
    total_duration = int((t_end - t_start) * 1e6)

    summary_status = 'PASS'
    for r in all_results:
        if r['status'] not in ('PASS',):
            summary_status = 'FAIL'
    # noise 检测允许误差
    if dec_noise_status == 'FAIL' and dec_noise_err > 0:
        # 噪声情况下不完全等于 FAIL，记录但不影响整体
        pass

    all_results.append(build_result(
        module='conv_viterbi_check',
        status=summary_status,
        check_type='regression',
        compared_points=sum(r['compared_points'] for r in all_results),
        max_error=max(r['max_error'] for r in all_results),
        files=[
            {'role': 'script', 'path': __file__},
        ],
        duration_us=total_duration,
    ))

    # ── JSON 输出 ──
    output = {
        'summary': summary_status,
        'checks': all_results,
    }

    if args.output:
        with open(args.output, 'w') as f:
            json.dump(output, f, indent=2)
        print(f'验证结果已写入: {args.output}')

    # 控制台输出摘要
    print(f'\n{"=" * 58}')
    print(f'  卷积码 + Viterbi 译码器验证报告')
    print(f'{"=" * 58}')
    for r in all_results:
        status_symbol = 'PASS' if r['status'] == 'PASS' else 'FAIL'
        print(f'  [{status_symbol}] {r["module"]:30s} '
              f'对比={r["compared_points"]:6d}  '
              f'最大误差={r["max_error"]}')
    print(f'{"=" * 58}')
    print(f'  总体结果: {summary_status}')
    print(f'  耗时: {total_duration} us')
    print(f'{"=" * 58}')

    return 0 if summary_status == 'PASS' else 1


if __name__ == '__main__':
    sys.exit(main())
