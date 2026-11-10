#!/usr/bin/env python3
"""
MarkItDown CLI wrapper with OCR support for scanned PDFs.

Usage:
    python markitdown-convert.py <input_file> [output_file] [--ocr-engine easyocr|paddleocr] [--lang ch_sim,en]

Exit codes:
    0 - Success
    1 - Conversion error
    2 - File not found
    3 - markitdown not installed
"""

import sys
import os
import json
import argparse
import io

# Fix encoding for Windows console
if sys.platform == 'win32':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')


def check_markitdown():
    """Check if markitdown is installed."""
    try:
        from markitdown import MarkItDown
        return True
    except ImportError:
        return False


def is_scanned_pdf(filepath):
    """Detect if a PDF is scanned (no text layer) by checking text content."""
    try:
        import fitz
        doc = fitz.open(filepath)
        total_text = ""
        # Check first 5 pages for text
        pages_to_check = min(5, len(doc))
        for i in range(pages_to_check):
            page = doc[i]
            total_text += page.get_text()
        doc.close()
        # If very little text found, it's likely scanned
        return len(total_text.strip()) < 50
    except Exception:
        return False


def ocr_pdf_pymupdf(filepath, engine='rapidocr', langs=None):
    """OCR a scanned PDF using pymupdf + OCR engine."""
    import fitz

    if langs is None:
        langs = ['ch_sim', 'en']

    # Initialize OCR reader
    if engine == 'rapidocr':
        from rapidocr_onnxruntime import RapidOCR
        reader = RapidOCR()
    elif engine == 'easyocr':
        import easyocr
        # Check if models are cached
        import pathlib
        model_dir = pathlib.Path.home() / '.EasyOCR' / 'model'
        if not model_dir.exists() or not any(model_dir.glob('*det*')):
            raise RuntimeError("easyocr models not downloaded. Run with --ocr-engine rapidocr instead.")
        reader = easyocr.Reader(langs, gpu=False, verbose=False)
    elif engine == 'paddleocr':
        from paddleocr import PaddleOCR
        lang_map = {'ch_sim': 'ch', 'en': 'en'}
        paddle_langs = [lang_map.get(l, l) for l in langs]
        # Use mobile model for faster initialization
        reader = PaddleOCR(
            text_detection_model_name='PP-OCRv5_mobile_det',
            text_recognition_model_name='PP-OCRv5_server_rec',
            lang=paddle_langs[0]
        )
    else:
        raise ValueError(f"Unknown OCR engine: {engine}")

    doc = fitz.open(filepath)
    all_text = []

    for page_num in range(len(doc)):
        page = doc[page_num]

        # Render page to image
        pix = page.get_pixmap(dpi=200)
        img_bytes = pix.tobytes("png")

        # OCR the image
        if engine == 'rapidocr':
            import tempfile
            with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as tmp:
                tmp.write(img_bytes)
                tmp_path = tmp.name
            result, _ = reader(tmp_path)
            os.unlink(tmp_path)
            if result:
                page_text = "\n".join([line[1] for line in result])
            else:
                page_text = ""
        elif engine == 'easyocr':
            import numpy as np
            from PIL import Image
            import io as _io
            img = Image.open(_io.BytesIO(img_bytes))
            img_array = np.array(img)
            results = reader.readtext(img_array)
            page_text = "\n".join([r[1] for r in results])
        elif engine == 'paddleocr':
            import tempfile
            with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as tmp:
                tmp.write(img_bytes)
                tmp_path = tmp.name
            results = reader.ocr(tmp_path)
            os.unlink(tmp_path)
            if results and results[0]:
                page_text = "\n".join([line[1][0] for line in results[0]])
            else:
                page_text = ""

        all_text.append(f"<!-- Page {page_num + 1} -->\n{page_text}")

    doc.close()
    return "\n\n".join(all_text)


def ocr_pdf_auto(filepath, langs=None):
    """Try OCR with available engines in order of preference."""
    engines = ['rapidocr', 'easyocr', 'paddleocr']  # rapidocr first as it's most reliable
    last_error = None

    for engine in engines:
        try:
            print(f"Trying {engine}...", file=sys.stderr)
            text = ocr_pdf_pymupdf(filepath, engine=engine, langs=langs)
            if text and len(text.strip()) > 10:
                return text
        except Exception as e:
            last_error = e
            print(f"{engine} failed: {e}", file=sys.stderr)
            continue

    raise RuntimeError(f"All OCR engines failed. Last error: {last_error}")


def convert_with_markitdown(filepath):
    """Convert file using markitdown library."""
    from markitdown import MarkItDown
    md = MarkItDown()
    result = md.convert(filepath)
    return result.text_content


def convert_file(filepath, output_file=None, ocr_engine='easyocr', langs=None):
    """Convert a file to markdown, with OCR fallback for scanned PDFs."""
    if not os.path.exists(filepath):
        return {"success": False, "error": f"File not found: {filepath}", "exit_code": 2}

    ext = os.path.splitext(filepath)[1].lower()

    # For PDF files, try markitdown first, then OCR if empty
    if ext == '.pdf':
        try:
            text = convert_with_markitdown(filepath)
            if text and len(text.strip()) > 50:
                return _make_result(filepath, text, output_file)
        except Exception:
            pass  # Fall through to OCR

        # Check if it's a scanned PDF
        if is_scanned_pdf(filepath):
            try:
                # If specific engine requested, try only that
                if ocr_engine and ocr_engine != 'auto':
                    text = ocr_pdf_pymupdf(filepath, engine=ocr_engine, langs=langs)
                else:
                    # Auto-detect: try all available engines
                    text = ocr_pdf_auto(filepath, langs=langs)
                return _make_result(filepath, text, output_file)
            except Exception as e:
                return {"success": False, "error": f"OCR failed: {e}", "exit_code": 1}

        return _make_result(filepath, "", output_file)

    # For non-PDF files, use markitdown directly
    try:
        text = convert_with_markitdown(filepath)
        return _make_result(filepath, text, output_file)
    except Exception as e:
        return {"success": False, "error": str(e), "exit_code": 1}


def _make_result(filepath, text, output_file):
    """Create standardized result dict."""
    result = {
        "success": True,
        "text_content": text,
        "char_count": len(text),
        "source_file": os.path.basename(filepath),
        "output_file": output_file
    }

    if output_file:
        os.makedirs(os.path.dirname(output_file) or '.', exist_ok=True)
        with open(output_file, 'w', encoding='utf-8') as f:
            f.write(text)

    return result


def main():
    parser = argparse.ArgumentParser(description='Convert files to Markdown with OCR support')
    parser.add_argument('input_file', help='Input file path')
    parser.add_argument('output_file', nargs='?', default=None, help='Output file path (optional)')
    parser.add_argument('--ext', default=None, help='File extension hint')
    parser.add_argument('--ocr-engine', choices=['rapidocr', 'easyocr', 'paddleocr', 'auto'], default='auto',
                        help='OCR engine for scanned PDFs (default: auto, tries all available)')
    parser.add_argument('--lang', default='ch_sim,en',
                        help='OCR languages, comma-separated (default: ch_sim,en)')

    args = parser.parse_args()

    if not check_markitdown():
        result = {"success": False, "error": "markitdown not installed. Run: pip install 'markitdown[all]'", "exit_code": 3}
        print(json.dumps(result, ensure_ascii=False))
        sys.exit(3)

    langs = args.lang.split(',') if args.lang else None
    result = convert_file(args.input_file, args.output_file, ocr_engine=args.ocr_engine, langs=langs)

    print(json.dumps(result, ensure_ascii=False))
    sys.exit(result.get("exit_code", 0 if result["success"] else 1))


if __name__ == '__main__':
    main()
