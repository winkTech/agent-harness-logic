#!/usr/bin/env python3
# ──────────────────────────────────────────────────────────────────────
# tv_gen.py — 卷积码 + Viterbi 译码测试向量生成器
# 生成 10 个测试向量，覆盖全零/全一/脉冲/随机/噪声/删余/量化/边界
# K=7, G1=171₈, G2=133₈, rates=1/2,2/3,3/4,5/6,7/8
#
# 输出格式:
#   .hex — 每行 1 bit (0/1)
#   .csv — 逗号分隔整数
# ──────────────────────────────────────────────────────────────────────

import csv
import math
import os
import random
import sys


# ══════════════════════════════════════════════════════════════════════
# 常量
# ══════════════════════════════════════════════════════════════════════

K = 7
N_STATES = 1 << (K - 1)  # 64
G1 = 0b1111001           # 171₈
G2 = 0b1011011           # 133₈

# 删余模式（1D 掩码，扁平串行 X0,Y0,X1,Y1,...）
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
# 网格图（Trellis）
# ══════════════════════════════════════════════════════════════════════

def build_trellis():
    """预计算网格图转移和期望输出。"""
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
    返回编码比特 [X0,Y0,X1,Y1,...]（不含收尾）。
    """
    sr = [0] * (K - 1)
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


def puncture(mother_bits, rate):
    """对母码比特流执行删余。"""
    pattern = PUNCTURE_PATTERNS[rate]
    period = len(pattern)
    return [b for i, b in enumerate(mother_bits) if pattern[i % period]]


def depuncture(punctured_bits, rate):
    """解删余：在删余位置插入中性值 (0)。"""
    pattern = PUNCTURE_PATTERNS[rate]
    period = len(pattern)
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
    while pidx % period != 0:
        if pattern[pidx % period] == 0:
            mother_bits.append(0)
            erasure_mask.append(0)
        pidx += 1
    return mother_bits, erasure_mask


# ══════════════════════════════════════════════════════════════════════
# Viterbi 硬判决译码器
# ══════════════════════════════════════════════════════════════════════

def viterbi_decode_hard(rx_bits, tb_len=None, erasure_mask=None):
    """硬判决 Viterbi 译码器 (K=7, rate=1/2)。"""
    if tb_len is None:
        tb_len = 5 * K

    if erasure_mask is None:
        erasure_mask = [1] * len(rx_bits)

    n_bits = len(rx_bits)
    if n_bits % 2 != 0:
        raise ValueError(f'rx_bits 长度必须为偶数，收到 {n_bits}')
    n_cycles = n_bits // 2

    pm = [float('inf')] * N_STATES
    pm[0] = 0
    surv = [[0] * N_STATES for _ in range(n_cycles)]

    for t in range(n_cycles):
        r0 = rx_bits[2 * t]
        r1 = rx_bits[2 * t + 1]
        e0 = erasure_mask[2 * t]
        e1 = erasure_mask[2 * t + 1]

        new_pm = [float('inf')] * N_STATES

        for ns in range(N_STATES):
            inp_bit = ns >> 5
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
        min_pm = min(pm)
        if min_pm > 0:
            pm = [p - min_pm for p in pm]

    # 回溯：从状态 0 开始（收尾保证归零）
    state = 0
    decoded = []
    for t in range(n_cycles - 1, -1, -1):
        decoded.append(state >> 5)
        state = surv[t][state]
    decoded.reverse()
    return decoded


# ══════════════════════════════════════════════════════════════════════
# Viterbi 软判决译码器
# ══════════════════════════════════════════════════════════════════════

def viterbi_decode_soft(rx_soft, tb_len=None, Q=3, erasure_mask=None):
    """软判决 Viterbi 译码器 (K=7, rate=1/2)。

    rx_soft: 软比特序列（0~2^Q-1 均匀量化）
    Q: 量化位数（不含符号，总位宽 Q）
    """
    if tb_len is None:
        tb_len = 5 * K

    if erasure_mask is None:
        erasure_mask = [1] * len(rx_soft)

    n_bits = len(rx_soft)
    if n_bits % 2 != 0:
        raise ValueError(f'rx_soft 长度必须为偶数，收到 {n_bits}')
    n_cycles = n_bits // 2

    max_val = (1 << Q) - 1  # 如 Q=3 -> 7
    # 期望值映射: 编码 bit 0 -> +max_val, bit 1 -> 0
    # 注意：软判决使用「可靠性」概念，0=最可靠为0, max_val=最可靠为1
    # 但我们使用 Euclidean 距离: ideal_map[bit] = bit * max_val
    ideal_map = [0, max_val]

    pm = [float('inf')] * N_STATES
    pm[0] = 0
    surv = [[0] * N_STATES for _ in range(n_cycles)]

    for t in range(n_cycles):
        r0 = rx_soft[2 * t]
        r1 = rx_soft[2 * t + 1]
        e0 = erasure_mask[2 * t]
        e1 = erasure_mask[2 * t + 1]

        new_pm = [float('inf')] * N_STATES

        for ns in range(N_STATES):
            inp_bit = ns >> 5
            prev0 = (ns << 1) & 0x3F
            prev1 = ((ns << 1) & 0x3F) | 1

            for prev in (prev0, prev1):
                exp0, exp1 = EXPECTED[prev][inp_bit]
                # Euclidean 距离平方
                bm = 0
                if e0:
                    diff0 = r0 - ideal_map[exp0]
                    bm += diff0 * diff0
                if e1:
                    diff1 = r1 - ideal_map[exp1]
                    bm += diff1 * diff1
                cand = pm[prev] + bm
                if cand < new_pm[ns]:
                    new_pm[ns] = cand
                    surv[t][ns] = prev

        pm = new_pm
        min_pm = min(pm)
        if min_pm > 0:
            pm = [p - min_pm for p in pm]

    # 回溯
    state = 0
    decoded = []
    for t in range(n_cycles - 1, -1, -1):
        decoded.append(state >> 5)
        state = surv[t][state]
    decoded.reverse()
    return decoded


# ══════════════════════════════════════════════════════════════════════
# 信道模型
# ══════════════════════════════════════════════════════════════════════

def bpsk_modulate(bits):
    """BPSK: 0 -> +1, 1 -> -1"""
    return [1 - 2 * b for b in bits]


def awgn_channel(symbols, ebno_db, code_rate=0.5):
    """AWGN 信道。

    symbols: BPSK 符号 {+1, -1}
    ebno_db: Eb/N0 (dB)
    code_rate: 编码码率
    返回: 接收符号（浮点）
    """
    n = len(symbols)
    # 噪声功率: N0/2 per dimension
    # Es/N0 = Eb/N0 + 10*log10(code_rate)  (BPSK 每符号 1 个编码比特)
    # No = Es / 10^(EsN0_db/10)
    esno_db = ebno_db + 10 * math.log10(code_rate)
    esno_linear = 10 ** (esno_db / 10)
    noise_std = math.sqrt(1.0 / (2 * esno_linear))

    rx = []
    for s in symbols:
        noise = random.gauss(0, noise_std)
        rx.append(s + noise)
    return rx


def quantize_soft(rx_float, Q):
    """均匀量化软比特。

    rx_float: 浮点接收值（BPSK: +1/-1 附近）
    Q: 量化位数（总位宽 = Q）
    返回: 0 ~ 2^Q-1 整数，0=最可靠 0, max=最可靠 1
    """
    max_val = (1 << Q) - 1
    # 将浮点值从 [-inf, +inf] 映射到 [0, max_val]
    # BPSK 硬判决阈值在 0，所以:
    #   rx=+1 (bit 0) -> max_val (最可靠 0)
    #   rx=-1 (bit 1) -> 0 (最可靠 1)
    # 用线性映射: 先 clip 到 [-scale, +scale], 再映射到 [0, max_val]
    scale = 3.0  # 饱和范围 ±3σ
    quant = []
    for v in rx_float:
        # 映射: (-scale) -> max_val, (+scale) -> 0
        # 但注意: BPSK 中 +1=bit0, -1=bit1
        # 我们期望: rx=+1 (接近 +scale) -> 接近 0?
        # 实际上标准做法: 0=最可靠 bit=0, max_val=最可靠 bit=1
        # 所以: +1 (bit 0) -> 0, -1 (bit 1) -> max_val
        # 但量化器通常用相反: +max = 最可能的 1
        # 让我们统一用: rx_soft 大=倾向于 bit 1, rx_soft 小=倾向于 bit 0
        # 映射: v -> normalized to [0, 1], 然后 * max_val
        # v=+1 -> normalized=0 (bit 0), v=-1 -> normalized=1 (bit 1)
        normalized = 1.0 - (v + scale) / (2 * scale)
        normalized = max(0.0, min(1.0, normalized))
        quant.append(round(normalized * max_val))
    return quant


def hard_decision(rx_float):
    """硬判决: < 0 -> 1, >= 0 -> 0"""
    return [1 if v < 0 else 0 for v in rx_float]


# ══════════════════════════════════════════════════════════════════════
# 文件 I/O
# ══════════════════════════════════════════════════════════════════════

def save_hex(bits, path):
    """保存 .hex 文件（每行 1 bit）。"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        for b in bits:
            f.write(f'{b}\n')
    print(f'  [HEX] {path} ({len(bits)} bits)')


def save_csv(values, path):
    """保存 .csv 文件（逗号分隔整数）。"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', newline='') as f:
        writer = csv.writer(f)
        writer.writerow(values)
    print(f'  [CSV] {path} ({len(values)} values)')


def load_hex(path):
    """加载 .hex 文件（每行 1 bit）。返回整数列表。"""
    bits = []
    with open(path, 'r') as f:
        for line in f:
            line = line.strip()
            if line:
                bits.append(int(line))
    return bits


# ══════════════════════════════════════════════════════════════════════
# 测试向量生成
# ══════════════════════════════════════════════════════════════════════

def generate_tv1(output_dir):
    """TV1: 全零输入 (100b)"""
    print('\n[TV1] 全零输入 (100b)')
    prefix = os.path.join(output_dir, 'tv1')
    data = [0] * 100
    coded = conv_encode_with_tail(data)
    save_hex(data, f'{prefix}_data_in.hex')
    save_hex(coded, f'{prefix}_coded_out.hex')

    # 译码验证
    decoded = viterbi_decode_hard(coded)
    errs = sum(1 for a, b in zip(data, decoded) if a != b)
    print(f'  [译码验证] 误差={errs}/100')
    return data, coded


def generate_tv2(output_dir):
    """TV2: 全一输入 (100b)"""
    print('\n[TV2] 全一输入 (100b)')
    prefix = os.path.join(output_dir, 'tv2')
    data = [1] * 100
    coded = conv_encode_with_tail(data)
    save_hex(data, f'{prefix}_data_in.hex')
    save_hex(coded, f'{prefix}_coded_out.hex')

    decoded = viterbi_decode_hard(coded)
    errs = sum(1 for a, b in zip(data, decoded) if a != b)
    print(f'  [译码验证] 误差={errs}/100')
    return data, coded


def generate_tv3(output_dir):
    """TV3: 孤立脉冲 [1, 0x99]"""
    print('\n[TV3] 孤立脉冲 [1, 0x99]')
    prefix = os.path.join(output_dir, 'tv3')
    data = [1] + [0] * 99
    coded = conv_encode_with_tail(data)
    save_hex(data, f'{prefix}_data_in.hex')
    save_hex(coded, f'{prefix}_coded_out.hex')

    decoded = viterbi_decode_hard(coded)
    errs = sum(1 for a, b in zip(data, decoded) if a != b)
    print(f'  [译码验证] 误差={errs}/100')
    return data, coded


def generate_tv4(output_dir):
    """TV4: 随机 (1000b) + AWGN @ Eb/N0=4dB (硬+软判决)"""
    print('\n[TV4] 随机 (1000b) + AWGN @ Eb/N0=4dB')
    prefix = os.path.join(output_dir, 'tv4')
    random.seed(42)
    data = [random.randint(0, 1) for _ in range(1000)]
    coded = conv_encode_with_tail(data)

    # 母码编码输出（不带收尾的编码比特，用于调制的）
    coded_no_tail = conv_encode(data)
    assert len(coded_no_tail) == 2000

    # BPSK + AWGN
    tx = bpsk_modulate(coded_no_tail)
    rx = awgn_channel(tx, ebno_db=4.0, code_rate=0.5)

    # 硬判决
    rx_hard = hard_decision(rx)
    # 软判决量化 (Q=3)
    rx_soft_q3 = quantize_soft(rx, Q=3)
    # 软判决量化 (Q=4)
    rx_soft_q4 = quantize_soft(rx, Q=4)

    # 保存
    save_hex(data, f'{prefix}_data_in.hex')
    save_hex(coded, f'{prefix}_coded_out.hex')
    save_hex(rx_hard, f'{prefix}_rx_hard.hex')
    save_csv(rx_soft_q3, f'{prefix}_rx_soft_q3.csv')
    save_csv(rx_soft_q4, f'{prefix}_rx_soft_q4.csv')
    # 保存浮点接收值以供参考
    rx_float_trunc = [round(v, 6) for v in rx]
    save_csv(rx_float_trunc, f'{prefix}_rx_float.csv')

    # 硬判决译码
    decoded_hard = viterbi_decode_hard(rx_hard)
    errs_hard = sum(1 for a, b in zip(data, decoded_hard) if a != b)
    print(f'  [硬判决译码] 误差={errs_hard}/1000')

    # 软判决译码 (Q=3)
    decoded_soft = viterbi_decode_soft(rx_soft_q3, Q=3)
    errs_soft = sum(1 for a, b in zip(data, decoded_soft) if a != b)
    print(f'  [软判决译码 Q=3] 误差={errs_soft}/1000')

    # 软判决译码 (Q=4)
    decoded_soft_q4 = viterbi_decode_soft(rx_soft_q4, Q=4)
    errs_soft_q4 = sum(1 for a, b in zip(data, decoded_soft_q4) if a != b)
    print(f'  [软判决译码 Q=4] 误差={errs_soft_q4}/1000')

    return data, coded, rx_hard, rx_soft_q3


def generate_tv5(output_dir):
    """TV5: 脉冲噪声 (10b burst)"""
    print('\n[TV5] 脉冲噪声 (10b burst)')
    prefix = os.path.join(output_dir, 'tv5')
    random.seed(123)
    data = [random.randint(0, 1) for _ in range(200)]
    coded = conv_encode_with_tail(data)
    coded_no_tail = conv_encode(data)

    # BPSK + 脉冲噪声（10 个连续符号翻转）
    tx = bpsk_modulate(coded_no_tail)
    # 在位置 50~59 注入脉冲（翻转符号）
    rx = list(tx)
    for i in range(50, min(60, len(rx))):
        rx[i] = -rx[i]  # 符号翻转 = 最严重错误
    # 再加一点背景噪声
    for i in range(len(rx)):
        rx[i] += random.gauss(0, 0.3)

    rx_hard = hard_decision(rx)
    rx_soft_q3 = quantize_soft(rx, Q=3)

    save_hex(data, f'{prefix}_data_in.hex')
    save_hex(coded, f'{prefix}_coded_out.hex')
    save_hex(rx_hard, f'{prefix}_rx_hard.hex')
    save_csv(rx_soft_q3, f'{prefix}_rx_soft_q3.csv')
    # 记录哪个位置被脉冲干扰
    burst_mask = [1 if 50 <= i < 60 else 0 for i in range(len(rx))]
    save_csv(burst_mask, f'{prefix}_burst_mask.csv')

    decoded = viterbi_decode_hard(rx_hard)
    errs = sum(1 for a, b in zip(data, decoded) if a != b)
    print(f'  [硬判决译码] 误差={errs}/200')
    return data, coded


def generate_tv6(output_dir):
    """TV6: 删余 rate=3/4 (200b)"""
    print('\n[TV6] 删余 rate=3/4 (200b)')
    prefix = os.path.join(output_dir, 'tv6')
    random.seed(456)
    data = [random.randint(0, 1) for _ in range(200)]
    # 母码含收尾比特，保证译码时归零
    coded_with_tail = conv_encode_with_tail(data)  # (200+6)*2=412b
    coded_mother = coded_with_tail                  # 母码 = 含收尾的编码输出
    coded_punc = puncture(coded_mother, (3, 4))

    save_hex(data, f'{prefix}_data_in.hex')
    save_hex(coded_mother, f'{prefix}_coded_out.hex')  # coded_out = 含收尾母码
    save_hex(coded_mother, f'{prefix}_coded_mother.hex')
    save_hex(coded_punc, f'{prefix}_coded_punc_3_4.hex')

    print(f'  data_in: {len(data)}b')
    print(f'  coded_mother: {len(coded_mother)}b')
    print(f'  coded_punc_3/4: {len(coded_punc)}b')

    # 译码验证：解删余后硬判决译码
    depunc_bits, erasure = depuncture(coded_punc, (3, 4))
    if len(depunc_bits) % 2 != 0:
        depunc_bits.append(0)
        erasure.append(0)
    decoded = viterbi_decode_hard(depunc_bits, erasure_mask=erasure)
    errs = sum(1 for a, b in zip(data, decoded[:len(data)]) if a != b)
    print(f'  [译码验证] 误差={errs}/200')
    return data, coded_mother, coded_punc


def generate_tv7(output_dir):
    """TV7: 所有码率删余 (2/3, 3/4, 5/6, 7/8)"""
    print('\n[TV7] 所有码率删余')
    random.seed(789)
    data = [random.randint(0, 1) for _ in range(500)]
    coded_mother = conv_encode_with_tail(data)  # 含收尾

    for rate_key in [(2, 3), (3, 4), (5, 6), (7, 8)]:
        label = RATE_LABELS[rate_key]
        print(f'  --- 码率 {rate_key[0]}/{rate_key[1]} ---')
        prefix = os.path.join(output_dir, f'tv7_rate_{label}')
        coded_punc = puncture(list(coded_mother), rate_key)

        save_hex(data, f'{prefix}_data_in.hex')
        save_hex(list(coded_mother), f'{prefix}_coded_mother.hex')
        save_hex(coded_punc, f'{prefix}_coded_punc_{label}.hex')

        print(f'    mother: {len(coded_mother)}b -> punc: {len(coded_punc)}b')

        # 译码验证
        depunc_bits, erasure = depuncture(coded_punc, rate_key)
        if len(depunc_bits) % 2 != 0:
            depunc_bits.append(0)
            erasure.append(0)
        decoded = viterbi_decode_hard(depunc_bits, erasure_mask=erasure)
        errs = sum(1 for a, b in zip(data, decoded[:len(data)]) if a != b)
        print(f'    [译码验证] 误差={errs}/{len(data)}')


def generate_tv8(output_dir):
    """TV8: 多级量化对比 (Q=1, 2, 3, 4)"""
    print('\n[TV8] 多级量化对比 (Q=1,2,3,4)')
    prefix = os.path.join(output_dir, 'tv8')
    random.seed(111)
    data = [random.randint(0, 1) for _ in range(500)]
    coded = conv_encode_with_tail(data)  # 含收尾，保证译码正确

    # AWGN @ Eb/N0=3dB (中等噪声，能看出量化差异)
    tx = bpsk_modulate(coded)
    rx = awgn_channel(tx, ebno_db=3.0, code_rate=0.5)

    quant_results = {}
    for Q in [1, 2, 3, 4]:
        if Q == 1:
            rx_q = hard_decision(rx)
            save_hex(rx_q, f'{prefix}_rx_hard.hex')
        else:
            rx_q = quantize_soft(rx, Q)
            save_csv(rx_q, f'{prefix}_rx_soft_q{Q}.csv')

        if Q == 1:
            decoded = viterbi_decode_hard(rx_q)
        else:
            decoded = viterbi_decode_soft(rx_q, Q=Q)

        errs = sum(1 for a, b in zip(data, decoded[:len(data)]) if a != b)
        quant_results[Q] = errs
        print(f'  Q={Q}: 误差={errs}/{len(data)}')

    save_hex(data, f'{prefix}_data_in.hex')
    save_hex(coded, f'{prefix}_coded_out.hex')
    return quant_results


def generate_tv9(output_dir):
    """TV9: 超短帧 (10b)"""
    print('\n[TV9] 超短帧 (10b)')
    prefix = os.path.join(output_dir, 'tv9')
    random.seed(222)
    data = [random.randint(0, 1) for _ in range(10)]
    coded = conv_encode_with_tail(data)  # (10+6)*2 = 32b

    save_hex(data, f'{prefix}_data_in.hex')
    save_hex(coded, f'{prefix}_coded_out.hex')

    decoded = viterbi_decode_hard(coded)
    errs = sum(1 for a, b in zip(data, decoded) if a != b)
    print(f'  [译码验证] 误差={errs}/10')
    return data, coded


def generate_tv10(output_dir):
    """TV10: 超长帧 (10000b)"""
    print('\n[TV10] 超长帧 (10000b)')
    prefix = os.path.join(output_dir, 'tv10')
    random.seed(333)
    data = [random.randint(0, 1) for _ in range(10000)]
    coded = conv_encode_with_tail(data)  # (10000+6)*2 = 20012b

    save_hex(data, f'{prefix}_data_in.hex')
    save_hex(coded, f'{prefix}_coded_out.hex')

    decoded = viterbi_decode_hard(coded)
    errs = sum(1 for a, b in zip(data, decoded) if a != b)
    print(f'  [译码验证] 误差={errs}/10000')
    return data, coded


# ══════════════════════════════════════════════════════════════════════
# 主入口
# ══════════════════════════════════════════════════════════════════════

def main():
    output_dir = sys.argv[1] if len(sys.argv) > 1 else 'D:/Project_Files/works/conv_viterbi_golden/tv'
    os.makedirs(output_dir, exist_ok=True)

    print('+-------------------------------------------------------------+')
    print('|  卷积码 + Viterbi 译码 -- 测试向量生成器                   |')
    print('|  K=7, G1=171_o, G2=133_o                                  |')
    print(f'|  输出目录: {output_dir}')
    print('+-------------------------------------------------------------+')

    generate_tv1(output_dir)
    generate_tv2(output_dir)
    generate_tv3(output_dir)
    generate_tv4(output_dir)
    generate_tv5(output_dir)
    generate_tv6(output_dir)
    generate_tv7(output_dir)
    generate_tv8(output_dir)
    generate_tv9(output_dir)
    generate_tv10(output_dir)

    # ── 文件列表 ──
    print('\n' + '=' * 60)
    print('  生成文件列表:')
    print('=' * 60)
    all_files = sorted(os.listdir(output_dir))
    for f in all_files:
        fpath = os.path.join(output_dir, f)
        size = os.path.getsize(fpath)
        print(f'  {f:50s} {size:>6d} bytes')

    print(f'\n全部完成！共 {len(all_files)} 个文件 -> {output_dir}')


if __name__ == '__main__':
    main()
