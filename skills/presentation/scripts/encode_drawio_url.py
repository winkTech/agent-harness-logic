#!/usr/bin/env python3
"""encode_drawio_url.py — draw.io XML ↔ 可分享 URL 的编解码。

draw.io 的 `#R<payload>` 分享链接里，payload = urlencode(base64(raw-deflate(xml)))。
手工拼容易在"raw deflate（无 zlib 头）"和"先 URL-encode 再 deflate"这两处出错，
本脚本把顺序固定下来，并提供反向解码用于校验。

用法:
    python encode_drawio_url.py encode diagram.drawio           # → 完整 URL
    python encode_drawio_url.py encode diagram.drawio --payload-only
    python encode_drawio_url.py decode "<payload 或完整 URL>"    # → XML
    python encode_drawio_url.py roundtrip diagram.drawio        # 自校验

退出码: 0 成功 | 1 编解码不一致 | 2 文件/参数问题
"""
from __future__ import annotations

import argparse
import base64
import os
import sys
import urllib.parse
import zlib

try:  # Windows 控制台默认 GBK；stderr 也要重配，否则中文报错被捕获时是乱码
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except Exception:  # noqa: BLE001
    pass

VIEWER = 'https://viewer.diagrams.net/?highlight=0000ff&edit=_blank&layers=1&nav=1#R'


def encode(xml: str) -> str:
    # 顺序固定：utf-8 → raw deflate(无 zlib 头) → base64 → urlencode
    comp = zlib.compressobj(9, zlib.DEFLATED, -zlib.MAX_WBITS)
    raw = comp.compress(xml.encode('utf-8')) + comp.flush()
    return urllib.parse.quote(base64.b64encode(raw).decode('ascii'))


def decode(payload: str) -> str:
    if '#R' in payload:
        payload = payload.split('#R', 1)[1]
    data = base64.b64decode(urllib.parse.unquote(payload))
    return zlib.decompress(data, -zlib.MAX_WBITS).decode('utf-8')


def read_xml(path: str) -> str:
    with open(path, encoding='utf-8') as fh:
        return fh.read()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('action', choices=['encode', 'decode', 'roundtrip'])
    ap.add_argument('target')
    ap.add_argument('--payload-only', action='store_true')
    args = ap.parse_args()

    if args.action in ('encode', 'roundtrip'):
        if not os.path.isfile(args.target):
            print(f'文件不存在: {args.target}', file=sys.stderr)
            return 2
        xml = read_xml(args.target)
        payload = encode(xml)
        if args.action == 'roundtrip':
            back = decode(payload)
            ok = back == xml
            print(f'原始 {len(xml)} 字符 → payload {len(payload)} 字符 → 还原 {len(back)} 字符')
            print('往返一致: ' + ('✅' if ok else '❌'))
            return 0 if ok else 1
        print(payload if args.payload_only else VIEWER + payload)
        return 0

    try:
        print(decode(args.target))
    except Exception as ex:  # noqa: BLE001
        print(f'解码失败: {ex}', file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
