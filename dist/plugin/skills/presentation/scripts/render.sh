#!/usr/bin/env bash
# render.sh — HTML 幻灯片 → PDF / 逐页 PNG（供视觉 QA 循环使用）
#
# 为什么需要：本技能的 QA 循环要求"渲染成图片后用子代理看"。人眼盯 HTML 源码
# 会看到自己想看的，不是浏览器实际渲染的。
#
# 优先级：headless Chrome/Edge（保真度最高） → wkhtmltopdf → LibreOffice
# 逐页 PNG 需要 pdftoppm（poppler）或 ImageMagick。
#
# 用法:
#   ./render.sh deck.html                 # → deck.pdf
#   ./render.sh deck.html out/            # → out/deck.pdf + out/slide-*.png
#   ./render.sh deck.html out/ --no-png
#
# 退出码: 0 成功 | 2 找不到渲染器 | 1 渲染失败
set -euo pipefail

SRC="${1:-}"
OUTDIR="${2:-.}"
NOPNG="${3:-}"

if [[ -z "$SRC" || ! -f "$SRC" ]]; then
  echo "用法: render.sh <deck.html> [outdir] [--no-png]" >&2
  exit 2
fi
mkdir -p "$OUTDIR"
BASE="$(basename "${SRC%.*}")"
PDF="$OUTDIR/$BASE.pdf"

# file:// URL（Windows 下 Git Bash 的路径要转成正斜杠绝对路径）
ABS="$(cd "$(dirname "$SRC")" && pwd)/$(basename "$SRC")"
URL="file:///${ABS#/}"

find_chrome() {
  for c in google-chrome chromium chromium-browser msedge chrome; do
    command -v "$c" >/dev/null 2>&1 && { echo "$c"; return 0; }
  done
  for p in \
    "/c/Program Files/Google/Chrome/Application/chrome.exe" \
    "/c/Program Files (x86)/Google/Chrome/Application/chrome.exe" \
    "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
    "/c/Program Files/Microsoft/Edge/Application/msedge.exe" \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; do
    [[ -f "$p" ]] && { echo "$p"; return 0; }
  done
  return 1
}

rendered=0
if CHROME="$(find_chrome)"; then
  echo "[render] 使用 $CHROME"
  # --no-pdf-header-footer 保证不带页眉页脚；--virtual-time-budget 等动画/字体就绪
  "$CHROME" --headless=new --disable-gpu --no-sandbox \
    --print-to-pdf="$PDF" --no-pdf-header-footer \
    --virtual-time-budget=8000 "$URL" >/dev/null 2>&1 && rendered=1 || rendered=0
fi

if [[ "$rendered" -ne 1 ]] && command -v wkhtmltopdf >/dev/null 2>&1; then
  echo "[render] 回退 wkhtmltopdf"
  wkhtmltopdf --enable-local-file-access "$SRC" "$PDF" && rendered=1 || rendered=0
fi

if [[ "$rendered" -ne 1 ]]; then
  SOF="$(dirname "$0")/office/soffice.py"
  if [[ -f "$SOF" ]]; then
    echo "[render] 回退 LibreOffice"
    python "$SOF" --headless --convert-to pdf --outdir "$OUTDIR" "$SRC" && rendered=1 || rendered=0
  fi
fi

if [[ "$rendered" -ne 1 ]]; then
  echo "[render] 找不到可用渲染器（Chrome/Edge、wkhtmltopdf、LibreOffice 均不可用）" >&2
  exit 2
fi
echo "[render] PDF: $PDF"

if [[ "$NOPNG" == "--no-png" ]]; then exit 0; fi

if command -v pdftoppm >/dev/null 2>&1; then
  pdftoppm -png -r 150 "$PDF" "$OUTDIR/slide"
  echo "[render] PNG: $(ls "$OUTDIR"/slide-*.png 2>/dev/null | wc -l) 张"
elif command -v magick >/dev/null 2>&1; then
  magick -density 150 "$PDF" "$OUTDIR/slide-%02d.png"
  echo "[render] PNG: $(ls "$OUTDIR"/slide-*.png 2>/dev/null | wc -l) 张"
else
  echo "[render] 未找到 pdftoppm/magick，跳过逐页 PNG（QA 循环需要图片，建议安装 poppler）" >&2
fi
