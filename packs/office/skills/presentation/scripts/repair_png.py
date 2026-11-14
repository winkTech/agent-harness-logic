#!/usr/bin/env python3
"""repair_png.py — 修复 draw.io 导出 PNG 的两个常见问题。

背景：`drawio -x -f png -e` 导出的是"带嵌入 XML 的 PNG"（XML 存在 zTXt/tEXt
块的 `mxfile` 关键字里，双击可再编辑）。踩过的坑：
  1. 某些图像工具（压缩/转换/截图再保存）会丢掉 tEXt 块 → 图还在，但**不可再编辑**
  2. 导出图四周留大片空白，插进文档后视觉重心跑偏

本脚本做三件事：
  - 校验 mxfile 元数据是否还在（丢了就明确报警，而不是让你上线后才发现）
  - 可选裁掉四周纯色边距（--trim），裁剪时**保留**元数据块
  - 可选按最长边缩放（--max-side），同样保留元数据

用法:
    python repair_png.py diagram.drawio.png                 # 只体检
    python repair_png.py diagram.drawio.png --trim --pad 24
    python repair_png.py diagram.drawio.png --max-side 2400 --out out.png

退出码: 0 正常 | 1 元数据丢失 | 2 文件/依赖问题
"""
from __future__ import annotations

import argparse
import os
import sys

try:  # Windows 控制台默认 GBK；stderr 也要重配，否则中文报错被捕获时是乱码
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except Exception:  # noqa: BLE001
    pass

META_KEYS = ('mxfile', 'mxGraphModel')


def load_meta(path: str) -> dict:
    """读出 PNG 文本块（PIL 会把 tEXt/zTXt 放进 img.info）。"""
    from PIL import Image
    with Image.open(path) as im:
        return {k: v for k, v in (im.info or {}).items() if isinstance(v, (str, bytes))}


def has_drawio_meta(meta: dict) -> bool:
    return any(k in meta for k in META_KEYS)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('image')
    ap.add_argument('--out', help='输出路径（默认原地覆盖，仅在有 --trim/--max-side 时写盘）')
    ap.add_argument('--trim', action='store_true', help='裁掉四周纯色边距')
    ap.add_argument('--pad', type=int, default=16, help='裁剪后保留的留白像素（默认 16）')
    ap.add_argument('--max-side', type=int, help='最长边缩放上限')
    args = ap.parse_args()

    if not os.path.isfile(args.image):
        print(f'文件不存在: {args.image}', file=sys.stderr)
        return 2
    try:
        from PIL import Image, PngImagePlugin
    except ImportError:
        print('缺少 Pillow — pip install pillow', file=sys.stderr)
        return 2

    meta = load_meta(args.image)
    meta_ok = has_drawio_meta(meta)
    with Image.open(args.image) as im:
        w0, h0 = im.size
        mode = im.mode
        work = im.convert('RGBA') if mode not in ('RGB', 'RGBA') else im.copy()

    print(f'尺寸: {w0}×{h0}  模式: {mode}')
    print(f'draw.io 可编辑元数据: {"✅ 存在" if meta_ok else "❌ 丢失"}'
          + ('' if meta_ok else '  → 该 PNG 无法再被 draw.io 打开编辑，请从 .drawio 源文件重新导出（带 -e）'))

    changed = False
    if args.trim:
        from PIL import ImageChops
        bg = Image.new(work.mode, work.size, work.getpixel((0, 0)))
        bbox = ImageChops.difference(work, bg).getbbox()
        if bbox:
            l, t, r, b = bbox
            l = max(0, l - args.pad); t = max(0, t - args.pad)
            r = min(work.width, r + args.pad); b = min(work.height, b + args.pad)
            if (l, t, r, b) != (0, 0, work.width, work.height):
                work = work.crop((l, t, r, b))
                changed = True
                print(f'裁剪: → {work.width}×{work.height}（留白 {args.pad}px）')
            else:
                print('裁剪: 无可裁边距')
        else:
            print('裁剪: 整图单色，跳过')

    if args.max_side and max(work.size) > args.max_side:
        ratio = args.max_side / max(work.size)
        new = (max(1, round(work.width * ratio)), max(1, round(work.height * ratio)))
        work = work.resize(new, Image.LANCZOS)
        changed = True
        print(f'缩放: → {new[0]}×{new[1]}')

    if changed:
        out = args.out or args.image
        pnginfo = PngImagePlugin.PngInfo()
        for k, v in meta.items():                      # 关键：把元数据带回去
            try:
                pnginfo.add_text(k, v if isinstance(v, str) else v.decode('utf-8', 'ignore'))
            except Exception:  # noqa: BLE001
                pass
        work.save(out, 'PNG', pnginfo=pnginfo)
        kept = has_drawio_meta(load_meta(out))
        print(f'已写出: {out}  元数据保留: {"✅" if kept or not meta_ok else "❌"}')
        if meta_ok and not kept:
            print('元数据在写回时丢失', file=sys.stderr)
            return 1

    return 0 if meta_ok else 1


if __name__ == '__main__':
    sys.exit(main())
