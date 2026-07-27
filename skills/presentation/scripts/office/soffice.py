#!/usr/bin/env python3
"""soffice.py — LibreOffice headless 包装器（跨平台定位 + 明确报错）。

直接调 `soffice` 的两个常见坑，本脚本负责兜住：
  1. Windows 上 soffice 不在 PATH 里（装在 Program Files 下），报 command not found
  2. 已有 LibreOffice GUI 实例在跑时，headless 调用会静默失败或挂起
     → 用独立的 -env:UserInstallation 配置目录隔离，避免抢用户 profile

用法（参数透传给 soffice）:
    python soffice.py --headless --convert-to pdf deck.pptx
    python soffice.py --headless --convert-to pdf --outdir out/ deck.pptx
    python soffice.py --which          # 只打印找到的可执行文件路径

退出码: 0 成功 | 2 找不到 LibreOffice | 其他 = soffice 自身退出码
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile

try:  # Windows 控制台默认 GBK；stderr 也要重配，否则中文报错被捕获时是乱码
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except Exception:  # noqa: BLE001
    pass

CANDIDATE_NAMES = ['soffice', 'libreoffice', 'soffice.exe']
CANDIDATE_PATHS = [
    r'C:\Program Files\LibreOffice\program\soffice.exe',
    r'C:\Program Files (x86)\LibreOffice\program\soffice.exe',
    '/usr/bin/soffice',
    '/usr/bin/libreoffice',
    '/usr/local/bin/soffice',
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
]


def find_soffice() -> str | None:
    env = os.environ.get('SOFFICE_BIN')
    if env and os.path.isfile(env):
        return env
    for name in CANDIDATE_NAMES:
        found = shutil.which(name)
        if found:
            return found
    for p in CANDIDATE_PATHS:
        if os.path.isfile(p):
            return p
    return None


def run(args: list[str], timeout: int = 300) -> int:
    exe = find_soffice()
    if not exe:
        print('[soffice] 找不到 LibreOffice。请安装，或设置 SOFFICE_BIN 指向 soffice 可执行文件。',
              file=sys.stderr)
        print('[soffice] 已尝试: PATH(' + ', '.join(CANDIDATE_NAMES) + ') 及常见安装位置。',
              file=sys.stderr)
        return 2

    # 隔离配置目录：避免与用户已打开的 LibreOffice 抢同一个 profile 而卡死
    with tempfile.TemporaryDirectory(prefix='lo_profile_') as profile:
        uri = 'file:///' + profile.replace('\\', '/').lstrip('/')
        cmd = [exe, f'-env:UserInstallation={uri}', *args]
        try:
            r = subprocess.run(cmd, timeout=timeout)
            return r.returncode
        except subprocess.TimeoutExpired:
            print(f'[soffice] 超时 {timeout}s —— 通常是转换文件过大或存在残留实例。', file=sys.stderr)
            return 1


def main() -> int:
    args = sys.argv[1:]
    if not args or args[0] in ('-h', '--help'):
        print(__doc__)
        return 0
    if args[0] == '--which':
        exe = find_soffice()
        if exe:
            print(exe)
            return 0
        print('(not found)')
        print('[soffice] 未找到 LibreOffice。安装后重试，或设置 SOFFICE_BIN 指向 soffice 可执行文件。',
              file=sys.stderr)
        print('[soffice] 已查找: PATH(' + ', '.join(CANDIDATE_NAMES) + ') 及常见安装位置。',
              file=sys.stderr)
        return 2
    return run(args)


if __name__ == '__main__':
    sys.exit(main())
