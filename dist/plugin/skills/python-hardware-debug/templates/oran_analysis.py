#!/usr/bin/env python3
"""
ORAN/eCPRI 前传接口分析工具

解析 eCPRI 帧、ORAN C-plane/U-plane 扩展头、BFP 压缩数据。
支持 PCAP 文件解析和原始二进制文件两种输入模式。

用法:
    # 解析 eCPRI pcap 文件
    python oran_analysis.py --pcap capture.pcap

    # 提取 U-plane IQ 数据
    python oran_analysis.py --pcap capture.pcap --extract-iq --output iq_samples.bin

    # 显示 C-plane 调度信息
    python oran_analysis.py --pcap capture.pcap --c-plane

    # 分析 BFP 压缩块
    python oran_analysis.py --bfp-file compressed.bin --analyze

    # 解析后通过星座图查看 IQ
    python oran_analysis.py --pcap capture.pcap --extract-iq --constellation --algo 64qam

依赖:
    numpy, matplotlib (基础)
    scapy (pcap 解析, 可选 — 无则用简化 PCAP 读取器)
"""

import argparse
import json
import os
import struct
import sys
from pathlib import Path
from typing import Optional, Dict, List, Tuple, Any

import numpy as np


# ============================================================================
# 常量
# ============================================================================

# eCPRI 消息类型
ECPRI_MSG_TYPES = {
    0: 'C-Plane (IQ Data)',
    1: 'U-Plane (Real-time control)',
    2: 'Delay Measurement',
    3: 'Remote Reset',
    4: 'Event Indication',
    5: 'Generic Data Transfer',
}

# ORAN 扩展头 Filter Index
ORAN_FILTER_INDEX = {
    0: 'No filter / standard',
    1: 'SRB (Scheduling Request)',
    2: 'SRS (Sounding Reference Signal)',
    3: 'PRACH',
    4: 'Msg1/3',
    255: 'Idle/Guard',
}

# U-plane dataDirection
DATA_DIRECTION = {
    0: 'Uplink (UL)',
    1: 'Downlink (DL)',
}

# BFP 压缩块大小 (字节)
BFP_BLOCK_SIZE_BYTES = {
    1: 6,   # 1 个 RE 块 = 6 bytes (exponent + mantissa × 1)
    2: 9,   # 2 个 RE 块 = 9 bytes
    4: 15,  # 4 个 RE 块 = 15 bytes
}

# RE 掩码
RE_MASK_NAMES = {
    0b0000000000: 'Empty',
    0b0000111111: 'All 6 RE in PRB',
    0b0000000011: 'RE 0-1',
    0b0011111100: 'RE 2-5',
}

# Section types
SECTION_TYPES = {
    0: 'PRB-based (standard)',
    1: 'RE mask-based',
}

# I/O sample widths
SAMPLE_WIDTHS = {
    1: '8-bit',
    2: '16-bit',
    4: '32-bit (float)',
}


# ============================================================================
# 简易 PCAP 解析器 (无需 scapy)
# ============================================================================

def parse_pcap_global_header(data: bytes) -> dict:
    """解析 PCAP 全局文件头 (24 bytes)"""
    magic = struct.unpack('<I', data[0:4])[0]
    if magic == 0xa1b2c3d4:
        endian = '<'  # Little endian
    elif magic == 0xd4c3b2a1:
        endian = '>'  # Big endian
    else:
        raise ValueError(f"Unknown pcap magic: 0x{magic:08x}")

    hdr = struct.unpack(f'{endian}IHHiIII', data[:24])
    return {
        'magic': hdr[0],
        'version_major': hdr[1],
        'version_minor': hdr[2],
        'thiszone': hdr[3],
        'sigfigs': hdr[4],
        'snaplen': hdr[5],
        'network': hdr[6],
        'endian': endian,
    }


def parse_pcap_packet(data: bytes, offset: int, endian: str) -> Tuple[dict, int]:
    """解析单个 PCAP 包 (16 bytes 头 + payload)"""
    hdr = struct.unpack(f'{endian}IIII', data[offset:offset + 16])
    ts_sec = hdr[0]
    ts_usec = hdr[1]
    incl_len = hdr[2]  # 写入文件的长度
    orig_len = hdr[3]  # 实际长度

    packet_data = data[offset + 16:offset + 16 + incl_len]
    return {
        'ts_sec': ts_sec,
        'ts_usec': ts_usec,
        'incl_len': incl_len,
        'orig_len': orig_len,
        'data': packet_data,
    }, offset + 16 + incl_len


def iter_pcap_packets(filepath: str):
    """迭代 PCAP 文件中的所有包"""
    with open(filepath, 'rb') as f:
        data = f.read()

    if len(data) < 24:
        return

    ghdr = parse_pcap_global_header(data[:24])
    offset = 24

    while offset < len(data):
        try:
            pkt, offset = parse_pcap_packet(data, offset, ghdr['endian'])
            yield pkt, ghdr
        except (struct.error, IndexError):
            break


# ============================================================================
# eCPRI 帧解析
# ============================================================================

def find_ecpri_in_packet(packet_data: bytes) -> List[bytes]:
    """
    在以太网包中查找 eCPRI 帧。
    假定标准 UDP 封装: Eth/IP/UDP → eCPRI payload
    或直接检查 payload 中的 eCPRI 同步字节。
    """
    ecpri_frames = []
    data = packet_data

    # 跳过以太网头 (14 bytes + VLAN tag 可能)
    offset = 0
    if len(data) < 14:
        return ecpri_frames

    eth_type = struct.unpack('!H', data[12:14])[0]
    if eth_type == 0x8100:  # VLAN tag
        eth_type = struct.unpack('!H', data[16:18])[0]
        offset = 18
    else:
        offset = 14

    # IPv4 (0x0800)
    if eth_type == 0x0800 and offset + 20 < len(data):
        ip_hdr_len = (data[offset] & 0x0F) * 4
        proto = data[offset + 9]
        if proto == 17:  # UDP
            udp_offset = offset + ip_hdr_len
            if udp_offset + 8 < len(data):
                udp_len = struct.unpack('!H', data[udp_offset + 4:udp_offset + 6])[0]
                ecpri_start = udp_offset + 8
                ecpri_end = min(ecpri_start + udp_len - 8, len(data))
                if ecpri_start < ecpri_end:
                    ecpri_frames.append(data[ecpri_start:ecpri_end])

    # 简化: 如果找不到 UDP 封装, 直接扫描全 payload
    if not ecpri_frames:
        # 搜索 eCPRI 同步标志 (0x10 或 0x1A 为首字节)
        for i in range(len(data) - 8):
            if data[i] in (0x10, 0x1A) and i + 8 < len(data):
                ecpri_frames.append(data[i:])

    return ecpri_frames


def parse_ecpri_common_header(data: bytes) -> dict:
    """解析 eCPRI 公共头 (8 bytes)"""
    if len(data) < 8:
        raise ValueError(f"eCPRI header too short: {len(data)} bytes")

    # Byte 0: Version (4 bits) + Reserved (3 bits) + C (1 bit)
    byte0 = data[0]
    version = (byte0 >> 4) & 0x0F
    c_bit = byte0 & 0x01  # 0=concatenation, 1=new message

    # Byte 1: Message Type (1 byte)
    msg_type = data[1]

    # Byte 2-3: Payload Size (16-bit, big endian)
    payload_size = struct.unpack('!H', data[2:4])[0]

    # Byte 4-7: PC/RTD_ID + sequence ID (16-bit each)
    pc_rtd_id = struct.unpack('!H', data[4:6])[0]
    seq_id = struct.unpack('!H', data[6:8])[0]

    return {
        'version': version,
        'c_bit': c_bit,
        'msg_type': msg_type,
        'msg_type_name': ECPRI_MSG_TYPES.get(msg_type, f'Unknown ({msg_type})'),
        'payload_size': payload_size,
        'pc_rtd_id': pc_rtd_id,
        'seq_id': seq_id,
        'subseq_id': (seq_id >> 8) & 0xFF,
        'subseq_idx': seq_id & 0xFF,
    }


def parse_ecpri_payload(header: dict, payload: bytes) -> dict:
    """根据消息类型解析 eCPRI payload"""
    result = {
        'header': header,
        'raw_payload': payload,
    }

    if header['msg_type'] == 0:  # C-Plane
        result['oran'] = parse_oran_c_plane(payload)
    elif header['msg_type'] == 1:  # U-Plane (IQ Data)
        result['oran'] = parse_oran_u_plane(payload)
    elif header['msg_type'] == 2:  # Delay Measurement
        result['delay'] = parse_delay_measurement(payload)
    elif header['msg_type'] == 3:  # Remote Reset
        result['remote_reset'] = {'reset_id': int.from_bytes(payload[:2], 'big')}
    elif header['msg_type'] == 5:  # Generic Data Transfer
        pass

    return result


# ============================================================================
# ORAN C-Plane 解析
# ============================================================================

def parse_oran_extension_header(data: bytes) -> Tuple[dict, int]:
    """解析 ORAN C/U-plane 扩展头 (4 bytes)"""
    if len(data) < 4:
        return {'error': 'Truncated'}, 0

    byte0 = data[0]
    byte1 = data[1]
    byte2 = data[2]
    byte3 = data[3]

    ext_hdr = {
        'data_direction': (byte0 >> 7) & 0x01,
        'data_direction_name': DATA_DIRECTION.get((byte0 >> 7) & 0x01, '?'),
        'payload_version': (byte0 >> 4) & 0x07,
        'filter_index': byte0 & 0x0F,
        'filter_index_name': ORAN_FILTER_INDEX.get(byte0 & 0x0F, f'Custom ({byte0 & 0x0F})'),
        'frame_id': byte1 >> 4,
        'subframe_id': byte1 & 0x0F,
        'slot_id': byte2,
        'symbol_id': byte3,
    }

    return ext_hdr, 4


def parse_oran_c_plane_section(data: bytes, start: int) -> Tuple[Optional[dict], int]:
    """解析 C-plane section (section type 0 标准格式: 8 bytes)"""
    if start + 8 > len(data):
        return None, 0

    sect_hdr = struct.unpack('!HBBBBH', data[start:start + 8])
    section = {
        'section_id': sect_hdr[0],
        'rb': (sect_hdr[1] >> 4) & 0x0F,  # resource block indicator
        'sym_inc': sect_hdr[1] & 0x01,
        'start_prbu': sect_hdr[2],
        'num_prbu': sect_hdr[3],
        're_mask': sect_hdr[4],
        're_mask_name': RE_MASK_NAMES.get(sect_hdr[4], f'0x{sect_hdr[4]:02x}'),
        'beam_id': sect_hdr[5],
    }

    return section, 8


def parse_oran_c_plane(payload: bytes) -> dict:
    """解析 C-plane 帧"""
    result = {}

    offset = 0

    # 扩展头
    ext_hdr, offset = parse_oran_extension_header(payload[offset:])
    result['extension_header'] = ext_hdr

    # Sections
    sections = []
    while offset + 8 <= len(payload):
        section, consumed = parse_oran_c_plane_section(payload, offset)
        if section is None:
            break
        sections.append(section)
        offset += consumed

    result['sections'] = sections
    result['num_sections'] = len(sections)
    result['raw_bytes'] = len(payload)

    return result


# ============================================================================
# ORAN U-Plane 解析
# ============================================================================

def parse_oran_u_plane_section(data: bytes, start: int) -> Tuple[Optional[dict], int]:
    """解析 U-plane section header（标准 section: 8 bytes + payload）"""
    if start + 8 > len(data):
        return None, 0

    hdr = struct.unpack('!HBBBBH', data[start:start + 8])

    section = {
        'section_id': hdr[0],
        'rb': (hdr[1] >> 4) & 0x0F,
        'sym_inc': hdr[1] & 0x01,
        'start_prbu': hdr[2],
        'num_prbu': hdr[3],
        're_mask': hdr[4],
        'beam_id': hdr[5],
    }

    # Section payload — IQ 数据
    # IQ 格式由 eCPRI 帧的 ibitWidth/qbitWidth 确定
    payload_offset = start + 8
    iq_payload = data[payload_offset:]

    section['iq_payload_bytes'] = len(iq_payload)
    section['prb_count'] = section['num_prbu']

    return section, 8 + len(iq_payload)


def parse_oran_u_plane(payload: bytes) -> dict:
    """解析 U-plane 帧 (IQ 数据)"""
    result = {}

    offset = 0

    # 扩展头
    ext_hdr, offset = parse_oran_extension_header(payload[offset:])
    result['extension_header'] = ext_hdr

    # Sections
    sections = []
    while offset + 8 <= len(payload):
        section, consumed = parse_oran_u_plane_section(payload, offset)
        if section is None:
            break
        sections.append(section)
        offset += consumed

        # 跳到下一个 section (每个 section 之间可能有 padding)
        # 实际解析需要更精确的 section 长度计算

    result['sections'] = sections
    result['num_sections'] = len(sections)
    result['iq_payload_total'] = sum(s.get('iq_payload_bytes', 0) for s in sections)

    return result


def extract_iq_from_u_plane(frame: dict, iq_width: int = 16) -> np.ndarray:
    """
    从 U-plane 帧提取 IQ 数据

    Args:
        frame: parse_ecpri_payload 返回的完整 U-plane 帧
        iq_width: I/Q 样本位宽 (8/16/32)

    Returns:
        numpy complex64 数组
    """
    payload = frame.get('raw_payload', b'')
    if not payload:
        return np.array([], dtype=np.complex64)

    # 跳过 ORAN 扩展头 (4 bytes)
    offset = 4
    samples = []

    while offset + 8 <= len(payload):
        # 跳过 section header (8 bytes)
        offset += 8

        # 提取 IQ 样本
        while offset + (iq_width // 4) <= len(payload):
            if iq_width == 16:
                if offset + 4 > len(payload):
                    break
                i_raw = struct.unpack('>h', payload[offset:offset + 2])[0]
                q_raw = struct.unpack('>h', payload[offset + 2:offset + 4])[0]
                samples.append(complex(i_raw / 32768.0, q_raw / 32768.0))
                offset += 4
            elif iq_width == 8:
                if offset + 2 > len(payload):
                    break
                i_raw = struct.unpack('>b', payload[offset:offset + 1])[0]
                q_raw = struct.unpack('>b', payload[offset + 1:offset + 2])[0]
                samples.append(complex(i_raw / 128.0, q_raw / 128.0))
                offset += 2
            else:
                break  # 不支持其他位宽

            # 简单限制: 每个 section 最多 256 个 IQ 对
            if len(samples) >= 256:
                break

    return np.array(samples, dtype=np.complex64)


# ============================================================================
# BFP 压缩/解压缩
# ============================================================================

def detect_bfp_blocks(data: bytes) -> List[dict]:
    """
    检测并解析 BFP 压缩块

    BFP 块格式:
      - block_exponent (4-bit or 8-bit)
      - mantissa_i[0..K-1] (每 RE 的 I mantissa)
      - mantissa_q[0..K-1] (每 RE 的 Q mantissa)

    Args:
        data: 原始二进制数据

    Returns:
        BFP 块列表 [{'exponent': int, 'i_mant': [...], 'q_mant': [...]}, ...]
    """
    blocks = []
    offset = 0

    while offset < len(data):
        if offset + 1 > len(data):
            break

        # 尝试检测块大小 (1 RE / 2 RE / 4 RE 块)
        # BFP 块头 1 byte = exponent (4bit) + reserved(4bit)
        exponent = (data[offset] >> 4) & 0x0F
        block_type = data[offset] & 0x0F

        # 根据块类型确定块大小
        if block_type in BFP_BLOCK_SIZE_BYTES:
            block_size = BFP_BLOCK_SIZE_BYTES[block_type]
        else:
            # 未知类型, 尝试 4 RE 块
            block_size = 15

        if offset + block_size > len(data):
            break

        block_data = data[offset:offset + block_size]
        offset += block_size

        # 解析 mantissa
        # 标准 BFP 6-bit mantissa: 每个 RE 的 I/Q 各 6-bit
        num_re = 1 if block_type == 1 else (2 if block_type == 2 else 4)
        mantissa_bits = 6
        total_bits = num_re * 2 * mantissa_bits + 8  # +8 for exponent byte

        i_mant = []
        q_mant = []

        # 简化实现: 从原始字节解析 6-bit mantissa 对
        bit_offset = 8  # 跳过 exponent byte
        for re_idx in range(num_re):
            # 提取 6-bit I mantissa (低 6-bit, sign-extended)
            byte_idx = bit_offset // 8
            bit_idx = bit_offset % 8

            # 简化: 直接取 1 byte 的低 6-bit
            if byte_idx < len(block_data):
                val = block_data[byte_idx]
                # sign extend 6-bit to 8-bit
                if val & 0x20:
                    val |= 0xC0  # sign extend
                i_mant.append((val << 2) >> 2)  # mask to 6-bit
                bit_offset += 6

            # Q mantissa
            byte_idx = bit_offset // 8
            bit_idx = bit_offset % 8
            if byte_idx < len(block_data):
                val = block_data[byte_idx]
                if val & 0x20:
                    val |= 0xC0
                q_mant.append((val << 2) >> 2)
                bit_offset += 6

        blocks.append({
            'exponent': exponent,
            'block_type': block_type,
            'num_re': num_re,
            'block_size': block_size,
            'i_mant': i_mant,
            'q_mant': q_mant,
        })

    return blocks


def decompress_bfp_blocks(blocks: List[dict]) -> np.ndarray:
    """
    BFP 解压缩 → IQ 浮点值

    iq = mantissa * 2^(exponent - 15)  (标准 BFP 公式)

    Args:
        blocks: detect_bfp_blocks 返回的块列表

    Returns:
        numpy complex64 数组
    """
    iq = []
    for block in blocks:
        exp = block['exponent']
        scale = 2.0 ** (exp - 15)
        max_mant = 2.0 ** 5  # 6-bit mantissa 的范围

        for i, q in zip(block['i_mant'], block['q_mant']):
            i_float = (i / max_mant) * scale
            q_float = (q / max_mant) * scale
            iq.append(complex(i_float, q_float))

    return np.array(iq, dtype=np.complex64)


def analyze_bfp(data: bytes) -> dict:
    """
    BFP 压缩分析

    Returns:
        dict: 压缩比统计, 块分布, 解压 IQ
    """
    blocks = detect_bfp_blocks(data)
    iq = decompress_bfp_blocks(blocks)

    # 统计
    block_types = {}
    for b in blocks:
        bt = b['block_type']
        block_types[bt] = block_types.get(bt, 0) + 1

    # 原始 IQ 估算
    num_blocks = len(blocks)
    num_re = sum(b['num_re'] for b in blocks)
    compressed_bytes = len(data)
    estimated_uncompressed = num_re * 4  # 假设 16-bit I + 16-bit Q

    compression_ratio = estimated_uncompressed / max(compressed_bytes, 1)

    return {
        'num_blocks': num_blocks,
        'num_re': num_re,
        'block_type_distribution': block_types,
        'compressed_bytes': compressed_bytes,
        'estimated_uncompressed_bytes': estimated_uncompressed,
        'compression_ratio': compression_ratio,
        'exponents': [b['exponent'] for b in blocks],
        'iq_decompressed': iq,
    }


# ============================================================================
# 报告与格式化
# ============================================================================

def fmt_ecpri_frame(frame: dict, detailed: bool = False) -> str:
    """格式化 eCPRI 帧为可读字符串"""
    hdr = frame['header']
    lines = []

    lines.append(f"  eCPRI: ver={hdr['version']}, type={hdr['msg_type']} "
                 f"({hdr['msg_type_name']}), payload={hdr['payload_size']}B, "
                 f"seq=0x{hdr['seq_id']:04x}")

    oran_data = frame.get('oran', {})
    ext = oran_data.get('extension_header', {})

    if ext:
        lines.append(f"    ORAN: {ext.get('data_direction_name', '?')} "
                     f"slot={ext.get('slot_id', '?')} "
                     f"frame={ext.get('frame_id', '?')}/{ext.get('subframe_id', '?')} "
                     f"sym={ext.get('symbol_id', '?')} "
                     f"filter={ext.get('filter_index_name', '?')}")

    if detailed:
        sections = oran_data.get('sections', [])
        for i, sect in enumerate(sections[:5]):  # 最多 5 个 section
            lines.append(f"    Sec[{i}]: id={sect.get('section_id', '?')} "
                         f"prb={sect.get('start_prbu', '?')}+{sect.get('num_prbu', '?')} "
                         f"beam={sect.get('beam_id', '?')}")

        if len(sections) > 5:
            lines.append(f"    ... +{len(sections) - 5} more sections")

    return '\n'.join(lines)


def generate_summary(frames: List[dict]) -> dict:
    """生成 eCPRI 前传流量摘要"""
    total = len(frames)
    msg_types = {}
    dir_counts = {'UL': 0, 'DL': 0}
    total_payload = 0
    slot_ids = set()
    symbol_ids = set()

    for frame in frames:
        hdr = frame['header']
        msg_types[hdr['msg_type']] = msg_types.get(hdr['msg_type'], 0) + 1
        total_payload += hdr['payload_size']

        oran_data = frame.get('oran', {})
        ext = oran_data.get('extension_header', {})
        if ext:
            dd = ext.get('data_direction', -1)
            if dd == 0:
                dir_counts['UL'] += 1
            elif dd == 1:
                dir_counts['DL'] += 1
            slot_ids.add(ext.get('slot_id', -1))
            symbol_ids.add(ext.get('symbol_id', -1))

    # C-plane / U-plane 分离
    c_plane = sum(v for k, v in msg_types.items() if k == 0)
    u_plane = sum(v for k, v in msg_types.items() if k == 1)

    return {
        'total_frames': total,
        'c_plane_count': c_plane,
        'u_plane_count': u_plane,
        'other_count': total - c_plane - u_plane,
        'msg_type_distribution': msg_types,
        'ul_dl_ratio': dir_counts,
        'total_payload_bytes': total_payload,
        'slot_range': f"{min(slot_ids) if slot_ids else '?'}-"
                      f"{max(slot_ids) if slot_ids else '?'}",
        'symbol_range': f"{min(symbol_ids) if symbol_ids else '?'}-"
                        f"{max(symbol_ids) if symbol_ids else '?'}",
        'effective_data_rate_mbps': total_payload * 8 / 1e6 if total else 0,
    }


# ============================================================================
# CLI
# ============================================================================

def run_pcap_analysis(args: argparse.Namespace) -> int:
    """从 PCAP 文件解析 eCPRI 帧"""
    pcap_path = args.pcap
    if not os.path.exists(pcap_path):
        print(f"[ERROR] PCAP file not found: {pcap_path}")
        return 1

    print(f"\n{'=' * 70}")
    print(f"  ORAN/eCPRI Capture Analysis")
    print(f"  File: {pcap_path}")
    print(f"{'=' * 70}\n")

    frames = []
    packet_count = 0
    ecpri_count = 0

    for pkt, ghdr in iter_pcap_packets(pcap_path):
        packet_count += 1
        ecpri_frames = find_ecpri_in_packet(pkt['data'])

        for raw in ecpri_frames:
            try:
                hdr = parse_ecpri_common_header(raw)
                payload = raw[8:]
                frame = parse_ecpri_payload(hdr, payload)
                frames.append(frame)
                ecpri_count += 1
            except (ValueError, struct.error) as e:
                if args.verbose:
                    print(f"  [WARN] Parse error: {e}")

    print(f"  Total packets: {packet_count}")
    print(f"  eCPRI frames:  {ecpri_count}\n")

    if not frames:
        print("  No eCPRI frames found.")
        return 0

    # 摘要
    summary = generate_summary(frames)
    print(f"  ┌─ ORAN Traffic Summary ────────────────────────────┐")
    print(f"  │  Total frames:       {summary['total_frames']:>6d}                  │")
    print(f"  │  C-Plane:            {summary['c_plane_count']:>6d}                  │")
    print(f"  │  U-Plane:            {summary['u_plane_count']:>6d}                  │")
    print(f"  │  Other:              {summary['other_count']:>6d}                  │")
    print(f"  │  UL / DL ratio:      {summary['ul_dl_ratio']['UL']} / "
          f"{summary['ul_dl_ratio']['DL']}                 │")
    print(f"  │  Slot range:         {summary['slot_range']:<20s}│")
    print(f"  │  Payload total:      {summary['total_payload_bytes'] / 1024:.1f} KB"
          f"                  │")
    print(f"  └──────────────────────────────────────────────────┘")
    print()

    # 逐帧详情
    detail_count = args.detail_count or min(20, len(frames))
    print(f"  --- First {detail_count} frames ---")
    for i, frame in enumerate(frames[:detail_count]):
        print(f"  [{i:3d}] {fmt_ecpri_frame(frame, args.verbose)}")

    if len(frames) > detail_count:
        print(f"  ... +{len(frames) - detail_count} more frames")

    # C-plane 详情
    if args.c_plane:
        print(f"\n  --- C-Plane Sections ---")
        for i, frame in enumerate(frames):
            oran_data = frame.get('oran', {})
            if oran_data.get('extension_header', {}).get('filter_index') is not None:
                ext = oran_data['extension_header']
                sections = oran_data.get('sections', [])
                print(f"  [{i:3d}] Slot {ext.get('slot_id', '?')}, Sym "
                      f"{ext.get('symbol_id', '?')}, "
                      f"{len(sections)} sections")

                for sect in sections[:10]:
                    print(f"        Sec {sect.get('section_id', '?')}: "
                          f"RB={sect.get('rb', '?')}, "
                          f"PRB={sect.get('start_prbu', '?')}+"
                          f"{sect.get('num_prbu', '?')}, "
                          f"Beam={sect.get('beam_id', '?')}")

    # IQ 提取
    if args.extract_iq:
        all_iq = []
        for frame in frames:
            oran_data = frame.get('oran', {})
            if oran_data.get('extension_header', {}).get('filter_index') is not None:
                iq = extract_iq_from_u_plane(frame, args.iq_width)
                if len(iq) > 0:
                    all_iq.append(iq)

        if all_iq:
            combined = np.concatenate(all_iq)
            print(f"\n  --- IQ Extraction ---")
            print(f"  Total IQ samples: {len(combined)}")

            # 保存到文件
            output_path = args.output or 'extracted_iq.bin'
            combined.astype(np.complex64).tofile(output_path)
            print(f"  Saved to: {output_path}")

            # 统计
            print(f"  I range: [{combined.real.min():.4f}, {combined.real.max():.4f}]")
            print(f"  Q range: [{combined.imag.min():.4f}, {combined.imag.max():.4f}]")
            print(f"  Power (avg): {np.mean(np.abs(combined) ** 2):.4f}")

            # 星座图
            if args.constellation:
                try:
                    _plot_constellation(combined, args.algo or 'QPSK')
                except ImportError:
                    print("  [WARN] matplotlib not available, skip constellation plot")
        else:
            print("  No U-plane IQ data found.")

    return 0


def run_bfp_analysis(args: argparse.Namespace) -> int:
    """分析 BFP 压缩文件"""
    bfp_path = args.bfp_file
    if not os.path.exists(bfp_path):
        print(f"[ERROR] BFP file not found: {bfp_path}")
        return 1

    with open(bfp_path, 'rb') as f:
        data = f.read()

    print(f"\n{'=' * 70}")
    print(f"  BFP Compression Analysis")
    print(f"  File: {bfp_path} ({len(data)} bytes)")
    print(f"{'=' * 70}\n")

    result = analyze_bfp(data)

    print(f"  Blocks:           {result['num_blocks']}")
    print(f"  RE total:         {result['num_re']}")
    print(f"  Block types:      {result['block_type_distribution']}")
    print(f"  Compressed:       {result['compressed_bytes']} B")
    print(f"  Uncompressed est: {result['estimated_uncompressed_bytes']} B")
    print(f"  Compression ratio: {result['compression_ratio']:.2f}x")
    print(f"  Exponent range:   [{min(result['exponents'])}, {max(result['exponents'])}]")

    if args.analyze:
        iq = result['iq_decompressed']
        print(f"\n  Decompressed IQ: {len(iq)} samples")
        if len(iq) > 0:
            print(f"    I range: [{iq.real.min():.6f}, {iq.real.max():.6f}]")
            print(f"    Q range: [{iq.imag.min():.6f}, {iq.imag.max():.6f}]")
            print(f"    Power:   {np.mean(np.abs(iq) ** 2):.6f}")

        # 保存解压缩 IQ
        iq_path = args.output or 'bfp_decompressed_iq.bin'
        iq.tofile(iq_path)
        print(f"    Saved:  {iq_path}")

        if args.constellation:
            try:
                _plot_constellation(iq, 'BFP')
            except ImportError:
                pass

    return 0


def _plot_constellation(iq: np.ndarray, title: str):
    """绘制星座图"""
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(1, 1, figsize=(8, 8))
    ax.plot(iq.real, iq.imag, '.', markersize=1, alpha=0.5)
    ax.set_title(f'ORAN eCPRI — {title} Constellation')
    ax.set_xlabel('I')
    ax.set_ylabel('Q')
    ax.set_aspect('equal')
    ax.grid(True, alpha=0.3)
    plt.tight_layout()
    plt.show()


def compute_evm(iq: np.ndarray, constellation: np.ndarray) -> Tuple[float, float, float]:
    """计算 EVM (Error Vector Magnitude)

    Args:
        iq: 实测 IQ 样本 (N,) complex64
        constellation: 理想星座点 (M,) complex64

    Returns:
        (evm_rms, evm_peak, evm_percentile95)
    """
    # 对每个实测点找最近的理想星座点
    evm_per_sample = np.zeros(len(iq))
    for i, sample in enumerate(iq):
        errors = np.abs(sample - constellation)
        evm_per_sample[i] = errors.min()

    # 归一化到星座图平均幅度
    avg_amplitude = np.mean(np.abs(constellation))
    evm_normalized = evm_per_sample / avg_amplitude

    evm_rms = np.sqrt(np.mean(evm_normalized ** 2)) * 100
    evm_peak = np.max(evm_normalized) * 100
    evm_p95 = np.percentile(evm_normalized, 95) * 100

    return evm_rms, evm_peak, evm_p95


def generate_modulation_constellation(algo: str) -> np.ndarray:
    """生成理想星座点"""
    if algo == 'qpsk':
        symbols = [1+1j, 1-1j, -1+1j, -1-1j]
    elif algo == '16qam':
        symbols = []
        for i in [-3, -1, 1, 3]:
            for q in [-3, -1, 1, 3]:
                symbols.append(i + 1j*q)
    elif algo == '64qam':
        symbols = []
        for i in [-7, -5, -3, -1, 1, 3, 5, 7]:
            for q in [-7, -5, -3, -1, 1, 3, 5, 7]:
                symbols.append(i + 1j*q)
    else:
        raise ValueError(f"Unknown modulation: {algo}")

    # 归一化为单位平均功率
    constellation = np.array(symbols, dtype=complex)
    avg_power = np.mean(np.abs(constellation) ** 2)
    constellation /= np.sqrt(avg_power)
    return constellation


def run_e2e_analysis(args: argparse.Namespace) -> int:
    """端到端分析: PCAP → IQ 提取 → EVM → 星座图 → 报告"""
    print("=" * 60)
    print(" ORAN/eCPRI 端到端分析")
    print("=" * 60)

    # Step 1: 解析 PCAP
    print("\n--- Step 1: PCAP Parsing ---")
    frames = list(iter_pcap_packets(args.pcap))
    print(f"  Total packets: {len(frames)}")

    ecpri_frames = []
    for frame in frames:
        ecpri_packets = find_ecpri_in_packet(frame['packet_data'])
        for pkt in ecpri_packets:
            hdr = parse_ecpri_common_header(pkt)
            payload = parse_ecpri_payload(hdr, pkt[8:])
            ecpri_frames.append({'header': hdr, 'payload': payload})
    print(f"  eCPRI frames: {len(ecpri_frames)}")

    # Step 2: 分类 C-plane / U-plane
    c_planes = [f for f in ecpri_frames if f['payload']['msg_type'] == 'C-plane']
    u_planes = [f for f in ecpri_frames if f['payload']['msg_type'] == 'U-plane']
    print(f"\n--- Step 2: Frame Classification ---")
    print(f"  C-plane: {len(c_planes)} frames")
    print(f"  U-plane: {len(u_planes)} frames")

    if not u_planes:
        print("  ⚠ No U-plane frames found — cannot extract IQ")
        return 1

    # Step 3: 提取 IQ
    print(f"\n--- Step 3: IQ Extraction ---")

    if args.c_plane:
        print("  C-plane scheduling info:")
        for i, cp in enumerate(c_planes[:5]):
            frame = cp['payload']['parsed']
            if 'sections' in frame:
                for sec in frame['sections']:
                    print(f"    [{i}] start_prb={sec.get('start_prb')} "
                          f"nrb={sec.get('nrb')} start_sym={sec.get('start_sym')}")

    # 提取 U-plane IQ
    iq_list = []
    for uf in u_planes:
        parsed = uf['payload']['parsed']
        if 'section' in parsed:
            iq = extract_iq_from_u_plane(parsed, args.iq_width)
            iq_list.append(iq)

    if not iq_list or all(len(iq) == 0 for iq in iq_list):
        print("  ⚠ No IQ data extracted")
        return 1

    all_iq = np.concatenate(iq_list)
    print(f"  IQ samples: {len(all_iq)}")

    # Step 4: EVM 计算
    print(f"\n--- Step 4: EVM Calculation ---")
    constellation = generate_modulation_constellation(args.algo)
    evm_rms, evm_peak, evm_p95 = compute_evm(all_iq, constellation)

    print(f"  Modulation: {args.algo.upper()}")
    print(f"  EVM RMS:    {evm_rms:.2f}%")
    print(f"  EVM Peak:   {evm_peak:.2f}%")
    print(f"  EVM P95:    {evm_p95:.2f}%")

    # 3GPP 规范检查
    evm_limits = {'qpsk': 17.5, '16qam': 12.5, '64qam': 8.0, 'BFP': 8.0}
    limit = evm_limits.get(args.algo, 12.5)
    if evm_rms < limit:
        print(f"  ✅ EVM within 3GPP spec ({args.algo.upper()} < {limit}%)")
    else:
        print(f"  ❌ EVM exceeds 3GPP spec ({args.algo.upper()} ≥ {limit}%)")

    # Step 5: 星座图
    if args.constellation:
        print(f"\n--- Step 5: Constellation Plot ---")
        _plot_constellation(all_iq, f"{args.algo.upper()} EVM={evm_rms:.2f}%")

    # Step 6: 报告输出
    if args.output:
        print(f"\n--- Step 6: Report ---")
        report = {
            'pcap': args.pcap,
            'packets': len(frames),
            'ecpri_frames': len(ecpri_frames),
            'c_plane_count': len(c_planes),
            'u_plane_count': len(u_planes),
            'iq_samples': len(all_iq),
            'modulation': args.algo,
            'evm_rms_pct': round(evm_rms, 2),
            'evm_peak_pct': round(evm_peak, 2),
            'evm_p95_pct': round(evm_p95, 2),
            'within_spec': evm_rms < limit,
        }
        import json
        with open(args.output, 'w') as f:
            json.dump(report, f, indent=2)
        print(f"  Report written to: {args.output}")

    return 0 if evm_rms < limit else 1


def main():
    parser = argparse.ArgumentParser(
        description='ORAN/eCPRI 前传接口分析工具',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # 解析 eCPRI pcap 文件
  python oran_analysis.py --pcap capture.pcap

  # 提取 U-plane IQ 数据
  python oran_analysis.py --pcap capture.pcap --extract-iq -o iq_samples.bin

  # 分析 BFP 压缩文件
  python oran_analysis.py --bfp-file compressed.bfp --analyze

  # 显示 C-plane 调度详情
  python oran_analysis.py --pcap capture.pcap --c-plane --verbose

  # 提取 IQ 并显示星座图
  python oran_analysis.py --pcap capture.pcap --extract-iq --constellation --algo 64qam
        """
    )

    # 输入源
    parser.add_argument('--pcap', type=str, default=None,
                        help='eCPRI PCAP 抓包文件')
    parser.add_argument('--bfp-file', type=str, default=None,
                        help='BFP 压缩数据文件')

    # 分析选项
    parser.add_argument('--e2e', action='store_true',
                        help='端到端分析: PCAP → IQ → EVM → 报告')
    parser.add_argument('--extract-iq', action='store_true',
                        help='从 U-plane 提取 IQ 数据')
    parser.add_argument('--c-plane', action='store_true',
                        help='显示 C-plane 调度信息')
    parser.add_argument('--analyze', action='store_true',
                        help='BFP 详细分析 (解压缩)')

    # 输出选项
    parser.add_argument('--output', '-o', type=str, default=None,
                        help='输出文件路径')
    parser.add_argument('--constellation', action='store_true',
                        help='显示星座图 (需要 matplotlib)')
    parser.add_argument('--algo', type=str, default='qpsk',
                        choices=['qpsk', '16qam', '64qam', 'BFP'],
                        help='调制方式 (星座图标注用)')
    parser.add_argument('--iq-width', type=int, default=16,
                        choices=[8, 16, 32],
                        help='IQ 样本位宽 (默认 16-bit)')
    parser.add_argument('--detail-count', type=int, default=10,
                        help='PCAP 解析时显示的帧数 (默认 10)')
    parser.add_argument('--verbose', '-v', action='store_true',
                        help='详细输出')

    args = parser.parse_args()

    if not args.pcap and not args.bfp_file:
        parser.print_help()
        print("\n[ERROR] Specify --pcap or --bfp-file")
        return 1

    if args.e2e:
        if not args.pcap:
            print("[ERROR] --e2e requires --pcap")
            return 1
        return run_e2e_analysis(args)
    elif args.pcap:
        return run_pcap_analysis(args)
    elif args.bfp_file:
        return run_bfp_analysis(args)

    return 0


if __name__ == '__main__':
    sys.exit(main())
