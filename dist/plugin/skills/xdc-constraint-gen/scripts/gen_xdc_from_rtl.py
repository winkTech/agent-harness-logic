#!/usr/bin/env python3
"""gen_xdc_from_rtl.py — 从 Verilog 顶层端口生成 XDC 约束骨架。

分工原则：机器只负责把端口名、方向、位宽抄对；周期数值、引脚号、
电平标准、例外路径全部留 TODO 标记，由人工按原理图与设计决策补值。
生成的是骨架，不是最终约束。

用法:
    python gen_xdc_from_rtl.py top.v                     # stdout 输出骨架
    python gen_xdc_from_rtl.py top.v --top top           # 文件含多 module 时指定顶层
    python gen_xdc_from_rtl.py top.v -o 03_xdc/top.xdc   # 写文件

只解析 Verilog-2001 ANSI 端口声明与普通非 ANSI 端口列表；
参数化位宽（如 [W-1:0]）与无法识别的声明在头部警告并跳过该端口 —— 不静默丢端口。
"""

import argparse
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

# 端口方向关键字
DIR_RE = r"(?:input|output|inout)"


@dataclass
class Port:
    name: str
    direction: str            # input / output / inout
    width: int | None         # None = 位宽含参数或不可解析
    raw_range: str | None     # 原始位宽文本，供人工核对
    notes: list[str] = field(default_factory=list)


def strip_comments(text: str) -> str:
    """去掉 // 行注释与 /* */ 块注释（约束生成不需要注释内容）。"""
    text = re.sub(r"/\*.*?\*/", " ", text, flags=re.S)
    text = re.sub(r"//[^\n]*", " ", text)
    return text


def find_modules(text: str) -> dict[str, str]:
    """返回 {模块名: 端口列表原文}。端口列表原文含 module 头括号内全部内容。"""
    modules = {}
    # module <name> ... ( ... ) ;  —— 端口列表可能跨多行
    for m in re.finditer(r"\bmodule\s+(\w+)\s*(?:#\s*\([^)]*\))?\s*\((.*?)\)\s*;", text, flags=re.S):
        modules[m.group(1)] = m.group(2)
    return modules


def parse_range(range_text: str | None) -> int | None:
    """[msb:lsb] → 位宽；全数字才解析，含参数名返回 None。"""
    if not range_text:
        return 1
    nums = re.findall(r"\d+", range_text)
    if len(nums) == 2 and re.fullmatch(r"\[\s*\d+\s*:\s*\d+\s*\]", range_text):
        return abs(int(nums[0]) - int(nums[1])) + 1
    return None


def parse_ansi_ports(port_list: str) -> tuple[list[Port], list[str]]:
    """解析 ANSI 端口声明：input wire [7:0] name / output reg name, ..."""
    ports: list[Port] = []
    warnings: list[str] = []
    # 逐段切分（逗号分隔），每段形如 (input|output|inout) [net_type] [signed] [range] name
    for seg in port_list.split(","):
        seg = seg.strip()
        if not seg:
            continue
        m = re.fullmatch(
            rf"({DIR_RE})\s+(?:wire|reg|logic)?\s*(?:signed\s+)?(\[[^\]]*\])?\s*(\w+)",
            seg,
        )
        if not m:
            warnings.append(f"无法解析的端口声明: '{seg}'（已跳过，请手工补进 XDC）")
            continue
        direction, rng, name = m.group(1), m.group(2), m.group(3)
        ports.append(Port(name=name, direction=direction,
                          width=parse_range(rng), raw_range=rng))
    return ports, warnings


def parse_non_ansi_ports(module_name: str, port_list: str, body: str) -> tuple[list[Port], list[str]]:
    """非 ANSI：头部只有名字列表，方向在 body 里声明（input [7:0] data;）。"""
    names = [n.strip() for n in port_list.split(",") if n.strip()]
    # body 内方向声明：input|output|inout [range] name (, name)* ;
    decl: dict[str, tuple[str, str | None]] = {}
    warnings: list[str] = []
    for m in re.finditer(rf"\b({DIR_RE})\s*(\[[^\]]*\])?\s*([\w\s,]+?)\s*;", body):
        direction, rng, name_list = m.group(1), m.group(2), m.group(3)
        for name in re.split(r"[,\s]+", name_list):
            if name:
                decl[name] = (direction, rng)
    ports: list[Port] = []
    for name in names:
        if name not in decl:
            warnings.append(f"端口 '{name}' 在模块体内找不到方向声明（已跳过）")
            continue
        direction, rng = decl[name]
        ports.append(Port(name=name, direction=direction,
                          width=parse_range(rng), raw_range=rng))
    return ports, warnings


def clock_like(port: Port) -> bool:
    return (port.direction == "input" and port.width == 1
            and re.search(r"clk|clock", port.name, flags=re.I) is not None)


def reset_like(port: Port) -> bool:
    return (port.direction == "input" and port.width == 1
            and re.search(r"rst|reset", port.name, flags=re.I) is not None)


def generate(top_name: str, ports: list[Port], source: Path) -> str:
    lines = [
        "# =====================================================================",
        f"# XDC 约束骨架 — 顶层: {top_name}",
        f"# 来源: {source.name}（gen_xdc_from_rtl.py 生成）",
        f"# 端口总数: {len(ports)}（时钟 {sum(clock_like(p) for p in ports)} / 复位候选 "
        f"{sum(reset_like(p) for p in ports)}）",
        "#",
        "# 分工：端口名/方向/位宽由脚本从 RTL 提取；周期、引脚号、电平标准、",
        "# 例外路径全部是 TODO，按原理图与设计决策补值。模板基准见",
        "# skills/xdc-constraint-gen/templates/ 下三个 .xdc。",
        "# =====================================================================",
        "",
        "# ---- 时钟约束 --------------------------------------------------------",
    ]
    clocks = [p for p in ports if clock_like(p)]
    if not clocks:
        lines.append("# (未识别到时钟端口；如有请按 templates/clock-period.xdc 手工补)")
    for p in clocks:
        lines.append(
            f"# TODO: 周期数值与波形待定（单位 ns）\n"
            f"# create_clock -period <TODO_ns> -name {p.name} "
            f"-waveform {{0.000 <TODO_ns/2>}} [get_ports {p.name}]"
        )
    lines += ["", "# ---- 管脚分配（每个端口一条，TODO 待补）-----------------------------"]
    for p in ports:
        target = f"{{{p.name}}}" if p.width is None or p.width > 1 else p.name
        width_note = "?" if p.width is None else str(p.width)
        lines.append(
            f"# {p.direction} {width_note} bit\n"
            f"set_property -dict {{PACKAGE_PIN <TODO> IOSTANDARD <TODO>}} [get_ports {target}]"
        )
    lines += ["", "# ---- 复位 / 异步信号提醒 ---------------------------------------------"]
    resets = [p for p in ports if reset_like(p)]
    if not resets:
        lines.append("# (未识别到复位端口)")
    for p in resets:
        lines.append(
            f"# TODO: '{p.name}' 若为异步复位，确认 RTL 已同步化后按 "
            f"templates/timing-exception.xdc 决定 false_path / max_delay"
        )
    lines += [
        "",
        "# ---- 位宽不可解析的端口（参数化位宽，人工核对）-----------------------",
    ]
    unknown = [p for p in ports if p.width is None]
    if not unknown:
        lines.append("# (无)")
    for p in unknown:
        lines.append(f"# {p.name}: 原始位宽 {p.raw_range} 含参数，请展开后核对")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description="从 Verilog 顶层端口生成 XDC 约束骨架")
    ap.add_argument("rtl", type=Path, help="顶层 RTL 文件 (.v)")
    ap.add_argument("--top", help="顶层模块名（文件含多个 module 时必须指定）")
    ap.add_argument("-o", "--output", type=Path, help="输出文件（缺省 stdout）")
    args = ap.parse_args()

    text = strip_comments(args.rtl.read_text(encoding="utf-8", errors="replace"))
    modules = find_modules(text)
    if not modules:
        print(f"错误: {args.rtl} 中未找到 module 声明", file=sys.stderr)
        return 2
    if args.top:
        if args.top not in modules:
            print(f"错误: 找不到模块 '{args.top}'（现有: {', '.join(modules)}）", file=sys.stderr)
            return 2
        top_name = args.top
    elif len(modules) == 1:
        top_name = next(iter(modules))
    else:
        print(f"错误: 文件含 {len(modules)} 个 module，请用 --top 指定（{', '.join(modules)}）",
              file=sys.stderr)
        return 2

    port_list = modules[top_name]
    # ANSI 判定：端口列表里出现方向关键字
    if re.search(rf"\b{DIR_RE}\b", port_list):
        ports, warnings = parse_ansi_ports(port_list)
    else:
        body_start = text.find(f"module {top_name}")
        body = text[body_start:]
        ports, warnings = parse_non_ansi_ports(top_name, port_list, body)

    if warnings:
        print("# 警告：", file=sys.stderr)
        for w in warnings:
            print(f"#   {w}", file=sys.stderr)

    out = generate(top_name, ports, args.rtl)
    if warnings:  # 警告同时进产物头部，人工不可漏读
        out = "# ⚠️ 以下端口未完整解析，生成结果需人工核对:\n" \
            + "".join(f"#   {w}\n" for w in warnings) + out

    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(out, encoding="utf-8")
        print(f"已写入 {args.output}（端口 {len(ports)}，警告 {len(warnings)}）", file=sys.stderr)
    else:
        print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
