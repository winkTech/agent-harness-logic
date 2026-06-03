#!/usr/bin/env python3
"""
寄存器配置脚本生成模板

用途: 根据 JSON/YAML 寄存器定义文件，生成 FPGA/芯片初始化配置脚本
支持输出格式: Vivado Tcl, hex/bin, CSV, Python dict, C header

用法:
    python config_gen.py --json regs.json --fmt tcl -o init.tcl
    python config_gen.py --json regs.json --fmt csv -o reg_table.csv
    python config_gen.py --json regs.json --fmt hex -o init.hex
    python config_gen.py --json regs.json --fmt c -o regs.h
    python config_gen.py --gen-template -o reg_template.json
"""

import argparse
import json
import sys
from pathlib import Path


def generate_template() -> dict:
    """生成寄存器定义模板 JSON"""
    return {
        "chip_name": "example_chip",
        "interface": {
            "type": "axi4-lite",
            "data_width": 32,
            "addr_width": 16
        },
        "registers": [
            {
                "name": "RESET",
                "address": "0x0000",
                "width": 32,
                "default": "0x00000000",
                "description": "软件复位控制",
                "fields": [
                    {"name": "soft_rst", "bits": [0, 0], "description": "软复位 (1=复位)"},
                    {"name": "tx_rst",   "bits": [1, 1], "description": "TX 模块复位"},
                    {"name": "rx_rst",   "bits": [2, 2], "description": "RX 模块复位"},
                ]
            },
            {
                "name": "CONTROL",
                "address": "0x0004",
                "width": 32,
                "default": "0x00000001",
                "description": "全局控制",
                "fields": [
                    {"name": "tx_en",   "bits": [0, 0], "description": "TX 使能"},
                    {"name": "rx_en",   "bits": [1, 1], "description": "RX 使能"},
                    {"name": "loop_en", "bits": [2, 2], "description": "环回模式"},
                    {"name": "gain",    "bits": [7, 4], "description": "数字增益"},
                ]
            },
            {
                "name": "FREQ_TUNE",
                "address": "0x0008",
                "width": 32,
                "default": "0x00000000",
                "description": "NCO 频率调谐字",
                "fields": [
                    {"name": "freq_tune", "bits": [31, 0], "description": "频率控制字 (32bit)"},
                ]
            },
            {
                "name": "BFP_CONFIG",
                "address": "0x000C",
                "width": 32,
                "default": "0x00000610",
                "description": "BFP 压缩配置",
                "fields": [
                    {"name": "bfp_en",      "bits": [0, 0],  "description": "BFP 使能"},
                    {"name": "bit_width",   "bits": [4, 1],  "description": "尾数位宽 (4~8)"},
                    {"name": "block_size",  "bits": [7, 5],  "description": "块大小: 0=4,1=8,2=16"},
                    {"name": "exp_offset",  "bits": [15, 8], "description": "指数偏移量"},
                ]
            },
            {
                "name": "STATUS",
                "address": "0x0010",
                "width": 32,
                "default": "0x00000000",
                "description": "状态寄存器 (只读)",
                "access": "ro",
                "fields": [
                    {"name": "pll_locked",    "bits": [0, 0], "description": "PLL 锁定状态"},
                    {"name": "jesd_sync",     "bits": [1, 1], "description": "JESD204B 同步状态"},
                    {"name": "temp_alarm",    "bits": [2, 2], "description": "温度告警"},
                    {"name": "tx_power_dbm",  "bits": [15, 8], "description": "发射功率 (dBm x 2)"},
                ]
            },
            {
                "name": "PARAM_1",
                "address": "0x0014",
                "width": 32,
                "default": "0x00000000",
                "description": "用户参数 1",
                "fields": [
                    {"name": "user_param", "bits": [31, 0], "description": "用户自定义参数"},
                ]
            },
            {
                "name": "TRIGGER",
                "address": "0x0018",
                "width": 32,
                "default": "0x00000000",
                "description": "触发寄存器",
                "fields": [
                    {"name": "capture_trig", "bits": [0, 0], "description": "采数触发脉冲"},
                    {"name": "calib_trig",   "bits": [1, 1], "description": "校准触发"},
                ]
            }
        ]
    }


def reg_value(reg: dict) -> int:
    """计算寄存器默认值 (按字段)"""
    value = int(reg.get('default', '0x0'), 16)
    fields = reg.get('fields', [])

    if not fields:
        return value

    # 按位域构造默认值
    result = 0
    for field in fields:
        if 'value' in field:
            mask = 0
            lo, hi = min(field['bits']), max(field['bits'])
            for b in range(lo, hi + 1):
                mask |= (1 << b)
            result = (result & ~mask) | ((field['value'] << lo) & mask)
        else:
            # 用 XML/JSON default 的对应位
            pass

    return result


def gen_tcl(regs: dict, output_file: str):
    """生成 Vivado Tcl 初始化脚本"""
    lines = []
    lines.append(f"# {regs['chip_name']} 初始化脚本")
    lines.append(f"# 生成时间: auto-generated")
    lines.append(f"# 接口: {regs['interface']['type']}")
    lines.append("")

    for reg in regs['registers']:
        addr = reg['address']
        val = reg_value(reg)
        name = reg['name']

        lines.append(f"# {name}: {reg.get('description', '')}")
        for field in reg.get('fields', []):
            lines.append(f"#   {field['name']}: bits[{field['bits'][1]}:{field['bits'][0]}]"
                        f" — {field['description']}")

        lines.append(f"reg_write {{{addr}}} {{{val:#010x}}}")
        lines.append("")

    result = '\n'.join(lines)

    if output_file:
        Path(output_file).write_text(result)
        print(f"Tcl script written: {output_file}")
    else:
        print(result)


def gen_csv(regs: dict, output_file: str):
    """生成 CSV 寄存器表"""
    lines = ["Name,Address,Width,Default,Description,Field,FieldBits,FieldDescription"]

    for reg in regs['registers']:
        fields = reg.get('fields', [])
        if fields:
            for f in fields:
                lines.append(f"{reg['name']},{reg['address']},{reg['width']},"
                            f"{reg.get('default', 'N/A')},\"{reg.get('description', '')}\","
                            f"{f['name']},{f['bits'][1]}:{f['bits'][0]},\"{f['description']}\"")
        else:
            lines.append(f"{reg['name']},{reg['address']},{reg['width']},"
                        f"{reg.get('default', 'N/A')},\"{reg.get('description', '')}\",-,-,-")

    result = '\n'.join(lines)

    if output_file:
        Path(output_file).write_text(result)
        print(f"CSV written: {output_file}")
    else:
        print(result)


def gen_hex(regs: dict, output_file: str):
    """生成 HEX 初始化文件 (Intel HEX 格式)"""
    import struct

    hex_lines = []
    # 简化的 HEX 格式: 只生成数据记录
    addr = 0
    data = []

    for reg in regs['registers']:
        reg_addr = int(reg['address'], 16)
        val = reg_value(reg)

        # 如果地址不连续, 补零
        while addr < reg_addr:
            data.extend([0, 0, 0, 0])
            addr += 4

        # 小端写入
        data.extend(struct.pack('<I', val))
        addr += 4

    if output_file:
        # 写二进制
        Path(output_file).write_bytes(bytes(data))
        print(f"HEX binary written: {output_file} ({len(data)} bytes)")
    else:
        # 打印 hex dump
        for i in range(0, len(data), 16):
            hex_str = ' '.join(f'{b:02x}' for b in data[i:i+16])
            print(f"{i:08x}: {hex_str}")


def gen_c_header(regs: dict, output_file: str):
    """生成 C 头文件"""
    lines = []
    name = regs['chip_name'].upper().replace('-', '_')
    lines.append(f"#ifndef __{name}_REGS_H__")
    lines.append(f"#define __{name}_REGS_H__")
    lines.append("")
    lines.append(f"/* {regs['chip_name']} 寄存器定义 */")
    lines.append("")

    for reg in regs['registers']:
        reg_name = f"REG_{name}_{reg['name']}"
        addr = reg['address']
        lines.append(f"/* {reg.get('description', '')} */")
        lines.append(f"#define {reg_name}_ADDR {addr}")

        for field in reg.get('fields', []):
            lo, hi = min(field['bits']), max(field['bits'])
            mask = ((1 << (hi - lo + 1)) - 1) << lo
            field_name = f"{reg_name}_{field['name'].upper()}"
            lines.append(f"#define {field_name}_MASK {mask:#010x}")
            lines.append(f"#define {field_name}_POS  {lo}")

        lines.append("")

    lines.append(f"#endif /* __{name}_REGS_H__ */")

    result = '\n'.join(lines)

    if output_file:
        Path(output_file).write_text(result)
        print(f"C header written: {output_file}")
    else:
        print(result)


def main():
    parser = argparse.ArgumentParser(description='寄存器配置脚本生成工具')
    parser.add_argument('--json', '-j', help='寄存器定义 JSON 文件')
    parser.add_argument('--gen-template', '-t', action='store_true',
                        help='生成模板 JSON')
    parser.add_argument('--fmt', choices=['tcl', 'csv', 'hex', 'c'],
                        default='tcl', help='输出格式')
    parser.add_argument('--out', '-o', help='输出文件')
    parser.add_argument('--set', '-s', nargs='*',
                        help='设置字段值, 格式: reg.field=value')
    args = parser.parse_args()

    # 生成模板
    if args.gen_template:
        template = generate_template()
        if args.out:
            Path(args.out).write_text(json.dumps(template, indent=2))
            print(f"Template written: {args.out}")
        else:
            print(json.dumps(template, indent=2))
        return

    # 加载寄存器定义
    if not args.json:
        parser.print_help()
        print("\nError: 需要 --json 或 --gen-template")
        sys.exit(1)

    with open(args.json, 'r') as f:
        regs = json.load(f)

    # 应用字段覆写
    if args.set:
        for override in args.set:
            parts = override.split('=')
            if len(parts) != 2:
                continue
            reg_field, value = parts
            reg_name, field_name = reg_field.split('.')
            val = int(value, 0)

            for reg in regs['registers']:
                if reg['name'] == reg_name:
                    for field in reg.get('fields', []):
                        if field['name'] == field_name:
                            field['value'] = val

    # 生成
    generators = {
        'tcl': gen_tcl,
        'csv': gen_csv,
        'hex': gen_hex,
        'c': gen_c_header,
    }

    gen = generators[args.fmt]
    gen(regs, args.out)


if __name__ == '__main__':
    main()
