---
name: markitdown-converter
version: 2.1.0
description: Convert files to Markdown with OCR support for scanned PDFs
category: utilities
tags: [file-conversion, markdown, pdf, ocr, docx, xlsx, images, audio]
tools: [Bash, Read, Write]
created_by: skill-creator
compliance_status: created-via-research-synthesis
research_synthesis: true
verified: true
source: builtin
trust_score: 100
provenance_sha: 16e3fa3301dfb5c6
---

# MarkItDown Converter Skill

Convert files (PDF, DOCX, XLSX, PPTX, HTML, CSV, images, audio) to Markdown using Microsoft's MarkItDown library. 支持扫描版 PDF 的 OCR 识别。

> **包装脚本位置**: `skills/markitdown-converter/scripts/markitdown-convert.py`
> （2026-07-27 补齐；此前文档引用的 `.claude/tools/cli/` 路径下并无此文件）。
>
> 相对上游 `markitdown` CLI 的增量：扫描版 PDF 自动检测 + 多 OCR 引擎自动降级
> （rapidocr → easyocr → paddleocr）+ 统一 JSON 输出 + 明确退出码契约。
> 基础依赖 `pip install "markitdown[all]"`；OCR 另需 `pip install pymupdf rapidocr-onnxruntime`。

## Usage

```javascript
Skill({ skill: 'markitdown-converter' });
// Then call the converter via Bash:
// bash: python skills/markitdown-converter/scripts/markitdown-convert.py <input_file> [output_file]
```

## Supported File Types

| Format          | Extensions                            |
| --------------- | ------------------------------------- |
| Documents       | .pdf, .docx, .pptx, .xlsx             |
| Web             | .html, .htm                           |
| Data            | .csv, .json, .xml                     |
| Images          | .jpg, .jpeg, .png, .gif, .webp        |
| Audio           | .mp3, .wav, .m4a                      |
| Archives        | .zip (extracts and converts contents) |
| Video platforms | YouTube URLs                          |

## Installation

```bash
# 基础依赖
pip install 'markitdown[all]'

# OCR 依赖（扫描版 PDF 需要）
pip install pymupdf rapidocr-onnxruntime
```

## CLI Wrapper

The CLI wrapper is at `skills/markitdown-converter/scripts/markitdown-convert.py`.

### 基本用法

```bash
# 转换文件到 stdout
python skills/markitdown-converter/scripts/markitdown-convert.py /path/to/file.pdf

# 转换并保存到输出文件
python skills/markitdown-converter/scripts/markitdown-convert.py /path/to/file.pdf /path/to/output.md

# 指定文件扩展名提示
python skills/markitdown-converter/scripts/markitdown-convert.py /path/to/file --ext .pdf
```

### 扫描版 PDF OCR 用法

```bash
# 使用 rapidocr 引擎（推荐，轻量快速）
python skills/markitdown-converter/scripts/markitdown-convert.py scanned.pdf output.md --ocr-engine rapidocr

# 自动选择引擎（按 rapidocr → easyocr → paddleocr 顺序尝试）
python skills/markitdown-converter/scripts/markitdown-convert.py scanned.pdf output.md --ocr-engine auto

# 指定语言
python skills/markitdown-converter/scripts/markitdown-convert.py scanned.pdf output.md --lang ch_sim,en
```

### 批量转换（含 OCR）

```bash
python -c "
import sys, os, glob, json, importlib.util
sys.stdout.reconfigure(encoding='utf-8')

spec = importlib.util.spec_from_file_location('md', 'skills/markitdown-converter/scripts/markitdown-convert.py')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

for pdf in glob.glob('*.pdf'):
    out = pdf.replace('.pdf', '.md')
    result = mod.convert_file(pdf, out, ocr_engine='rapidocr')
    status = 'OK' if result['success'] else 'FAIL'
    print(f'{status}: {pdf} -> {out} ({result.get(\"char_count\", 0)} chars)')
"
```

## OCR 工作原理

### 扫描检测流程

```
PDF 文件
  │
  ├─ markitdown 提取文本
  │    ├─ 有文本（>50字符）→ 直接输出 Markdown
  │    └─ 无文本/极少文本 ↓
  │
  ├─ is_scanned_pdf() 检测
  │    └─ 检查前5页文本量 < 50字符 → 判定为扫描版
  │
  └─ OCR 流程
       ├─ pymupdf 渲染页面为图片（200 DPI）
       ├─ OCR 引擎识别文字
       └─ 输出带页码注释的 Markdown
```

### OCR 引擎对比

| 引擎 | 安装 | 中文支持 | 速度 | 准确度 | 备注 |
|------|------|----------|------|--------|------|
| **rapidocr** | `pip install rapidocr-onnxruntime` | ✅ 优秀 | 快 | 高 | **推荐**，轻量无需 GPU |
| easyocr | `pip install easyocr` | ✅ 优秀 | 中等 | 高 | 首次需下载模型 |
| paddleocr | `pip install paddleocr` | ✅ 最优 | 快 | 最高 | 有 oneDNN 兼容性问题 |

### 输出格式

OCR 结果包含页码注释，便于定位：

```markdown
<!-- Page 1 -->
第一章 概述
本章介绍...

<!-- Page 2 -->
1.1 背景
在FPGA设计中...
```

## Exit Codes

| Code | Meaning                            |
| ---- | ---------------------------------- |
| 0    | Success — JSON with `text_content` |
| 1    | Conversion error                   |
| 2    | File not found                     |
| 3    | markitdown not installed           |

## JSON Output Format

```json
{
  "success": true,
  "text_content": "# Document Title\n\nContent here...",
  "char_count": 1234,
  "source_file": "report.pdf",
  "output_file": null
}
```

## Integration with Telegram File Drop

When a user sends a file in Telegram:

```javascript
// 1. Download the file to tmp
const tmpPath = `.claude/context/tmp/telegram-upload-${userId}-${Date.now()}.${ext}`;

// 2. Run markitdown converter (with OCR fallback)
const result = JSON.parse(
  execSync(`python skills/markitdown-converter/scripts/markitdown-convert.py "${tmpPath}" --ocr-engine easyocr`).toString()
);

// 3. Store as agent memory
if (result.success) {
  MemoryRecord({ type: 'discovery', text: result.text_content.slice(0, 2000), area: 'user-files' });
}
```

## Error Handling

```javascript
// Check if markitdown is installed
const { status } = spawnSync('python', ['skills/markitdown-converter/scripts/markitdown-convert.py', '--help']);
if (status === 3) {
  // Not installed — guide user
  sendMessage(chatId, 'File conversion requires: pip install markitdown[all]');
}
```

## When to Use

- User drops a file in Telegram → convert to markdown → store as memory
- Agent needs to process uploaded documents
- Convert research papers (PDF) to searchable markdown
- Extract data from spreadsheets (XLSX → markdown tables)
- **扫描版 PDF** → OCR 识别后转为可搜索 Markdown

## 常见问题

### Q: 扫描版 PDF 转换后为空？
A: CLI 会自动检测并使用 OCR。如自动检测失败，可手动指定 `--ocr-engine` 参数。

### Q: OCR 识别中文不准确？
A: 推荐使用 paddleocr 引擎：`--ocr-engine paddleocr`

### Q: 如何提高 OCR 速度？
A: 可降低 DPI（修改源码中 `dpi=200` 为 `dpi=150`），或使用 GPU 加速（需修改源码 `gpu=True`）。
