#!/usr/bin/env python3
"""markitdown-convert.py — MarkItDown 包装器，带扫描版 PDF 的 OCR 兜底。

相对上游 `markitdown` CLI 的增量：
  - 扫描版 PDF 自动检测（前几页文本量过低即判定），自动转 OCR
  - 多 OCR 引擎选择与自动降级：rapidocr → easyocr → paddleocr
  - 统一 JSON 输出，便于 Agent 直接解析（而不是解析人类可读文本）
  - 明确的退出码契约

用法:
    python markitdown-convert.py <input> [output.md] [--ext .pdf]
                                 [--ocr-engine auto|rapidocr|easyocr|paddleocr|none]
                                 [--lang ch_sim,en] [--dpi 200]

退出码:
    0 成功 | 1 转换错误 | 2 文件不存在 | 3 markitdown 未安装
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys

try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except Exception:  # noqa: BLE001
    pass

EXIT_OK, EXIT_CONVERT_ERROR, EXIT_NOT_FOUND, EXIT_NO_MARKITDOWN = 0, 1, 2, 3

# 判定"扫描版"的阈值：前 SCAN_PAGES 页提取到的文本少于 SCAN_MIN_CHARS 个字符
SCAN_PAGES = 5
SCAN_MIN_CHARS = 50


def _emit(payload: dict, code: int) -> int:
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return code


def is_scanned_pdf(path: str) -> bool:
    """前几页几乎没有可提取文本 → 判定为扫描件。pymupdf 缺失时保守返回 False。"""
    try:
        import fitz  # PyMuPDF
    except ImportError:
        return False
    try:
        with fitz.open(path) as doc:
            total = 0
            for page in list(doc)[:SCAN_PAGES]:
                total += len((page.get_text() or '').strip())
            return total < SCAN_MIN_CHARS
    except Exception:  # noqa: BLE001
        return False


def _ocr_rapidocr(images, _lang):
    from rapidocr_onnxruntime import RapidOCR
    engine = RapidOCR()
    out = []
    for img in images:
        res, _ = engine(img)
        out.append('\n'.join(line[1] for line in (res or [])))
    return out


def _ocr_easyocr(images, lang):
    import easyocr
    langs = [l.strip() for l in (lang or 'ch_sim,en').split(',') if l.strip()]
    langs = ['ch_sim' if l in ('ch', 'zh', 'chinese') else l for l in langs]
    reader = easyocr.Reader(langs, gpu=False)
    return ['\n'.join(reader.readtext(img, detail=0)) for img in images]


def _ocr_paddleocr(images, lang):
    from paddleocr import PaddleOCR
    ocr = PaddleOCR(use_angle_cls=True, lang='ch' if 'ch' in (lang or 'ch') else 'en', show_log=False)
    out = []
    for img in images:
        res = ocr.ocr(img, cls=True)
        lines = []
        for block in (res or []):
            for item in (block or []):
                lines.append(item[1][0])
        out.append('\n'.join(lines))
    return out


OCR_ENGINES = [('rapidocr', _ocr_rapidocr), ('easyocr', _ocr_easyocr), ('paddleocr', _ocr_paddleocr)]


def ocr_pdf(path: str, engine: str, lang: str, dpi: int) -> tuple[str, str]:
    """渲染 PDF 页面为图片后 OCR。返回 (markdown, 实际使用的引擎)。"""
    import fitz
    images = []
    with fitz.open(path) as doc:
        for page in doc:
            pix = page.get_pixmap(dpi=dpi)
            images.append(pix.tobytes('png'))

    candidates = OCR_ENGINES if engine in ('auto', '', None) else [e for e in OCR_ENGINES if e[0] == engine]
    if not candidates:
        raise RuntimeError(f'未知 OCR 引擎: {engine}')

    errors = []
    for name, fn in candidates:
        try:
            pages = fn(images, lang)
        except ImportError as ex:
            errors.append(f'{name}: 未安装 ({ex})')
            continue
        except Exception as ex:  # noqa: BLE001
            errors.append(f'{name}: {ex}')
            continue
        md = '\n\n'.join(f'<!-- Page {i + 1} -->\n{t}' for i, t in enumerate(pages))
        return md, name
    raise RuntimeError('所有 OCR 引擎均不可用 → ' + '; '.join(errors))


def convert_file(src: str, dst: str | None = None, ext: str | None = None,
                 ocr_engine: str = 'auto', lang: str = 'ch_sim,en', dpi: int = 200) -> dict:
    """转换单个文件。返回结果 dict（与 CLI 的 JSON 输出同构）。"""
    if not os.path.isfile(src):
        return {'success': False, 'error': 'file not found', 'source_file': src, '_code': EXIT_NOT_FOUND}
    try:
        from markitdown import MarkItDown
    except ImportError:
        return {'success': False, 'error': "markitdown not installed — pip install 'markitdown[all]'",
                'source_file': src, '_code': EXIT_NO_MARKITDOWN}

    text, used_ocr = '', None
    try:
        kwargs = {'file_extension': ext} if ext else {}
        text = (MarkItDown().convert(src, **kwargs).text_content or '').strip()
    except Exception as ex:  # noqa: BLE001
        text = ''
        first_error = str(ex)
    else:
        first_error = None

    is_pdf = (ext or os.path.splitext(src)[1]).lower() == '.pdf'
    if is_pdf and ocr_engine != 'none' and len(text) < SCAN_MIN_CHARS and is_scanned_pdf(src):
        try:
            text, used_ocr = ocr_pdf(src, ocr_engine, lang, dpi)
        except Exception as ex:  # noqa: BLE001
            if not text:
                return {'success': False, 'error': f'OCR failed: {ex}', 'source_file': src,
                        '_code': EXIT_CONVERT_ERROR}

    if not text and first_error:
        return {'success': False, 'error': first_error, 'source_file': src, '_code': EXIT_CONVERT_ERROR}

    if dst:
        os.makedirs(os.path.dirname(os.path.abspath(dst)) or '.', exist_ok=True)
        with io.open(dst, 'w', encoding='utf-8') as fh:
            fh.write(text)

    return {'success': True, 'text_content': text, 'char_count': len(text),
            'source_file': src, 'output_file': dst, 'ocr_engine': used_ocr, '_code': EXIT_OK}


def main() -> int:
    ap = argparse.ArgumentParser(description='Convert documents to Markdown (with OCR fallback).')
    ap.add_argument('input')
    ap.add_argument('output', nargs='?')
    ap.add_argument('--ext', help='扩展名提示，如 .pdf（输入文件无后缀时使用）')
    ap.add_argument('--ocr-engine', default='auto', choices=['auto', 'rapidocr', 'easyocr', 'paddleocr', 'none'])
    ap.add_argument('--lang', default='ch_sim,en')
    ap.add_argument('--dpi', type=int, default=200)
    args = ap.parse_args()

    result = convert_file(args.input, args.output, args.ext, args.ocr_engine, args.lang, args.dpi)
    code = result.pop('_code', EXIT_OK)
    # stdout 输出时截断正文，避免刷屏；写文件时正文已落盘
    if result.get('success') and args.output:
        result['text_content'] = result['text_content'][:500] + ('…' if result['char_count'] > 500 else '')
    return _emit(result, code)


if __name__ == '__main__':
    sys.exit(main())
