### 3. Excel 文件检索策略

**工作流**：

1. **首先：读取处理方法指南**
   - 在处理任何 Excel 之前，**必须先读取**：
     - [references/excel_reading.md](excel_reading.md) - 学习如何读取工作表
     - [references/excel_analysis.md](excel_analysis.md) - 学习如何分析数据
   - 重点了解：pandas 读取方法、列筛选、数据过滤、聚合操作
   
2. **选择候选 Excel**
   - 根据 `data_structure.md` 和文件/工作表命名，选择最相关的表
   - 优先选择包含「报表」「统计」「日志」「配置」「映射」等关键词的工作簿/工作表
   - 若用户指明具体 Excel 文件，优先使用该文件

3. **应用学到的方法探索结构**
   - 使用 pandas 读取前 10-50 行（使用 `nrows` 参数限制）
   - 重点掌握：列名/字段名、数据类型（数值、日期、文本）、关键字段
   - 将列名与用户问题比对，识别潜在关键字段（如「收入」「销售额」「error_code」等）
   
4. **执行数据检索和分析**
   - 使用学到的 pandas 方法进行过滤和聚合（如 `df[df['column'] == value]`）
   - 每次只读取匹配行附近的数据，避免一次性读取整表
   - 如问题包含时间范围，在检索中加入时间过滤
   - 应用「多轮迭代检索机制」（见上文公共检索原则）

## 与其他工具的协同

### PDF 处理
- **在处理 PDF 前必须先读取** [pdf_reading.md](pdf_reading.md) 学习处理方法
- 使用 pdfplumber/pypdf 进行文本提取、表格提取、元数据读取
- 优先使用 pdftotext 命令行工具进行快速文本提取

### Excel 处理
- **在处理 Excel 前必须先读取**：
  - [excel_reading.md](excel_reading.md) - 学习读取方法
  - [excel_analysis.md](excel_analysis.md) - 学习分析方法
- 使用 pandas 进行数据探索、预览、过滤和分析

### 工具使用原则
- **Grep**：用于按关键词在指定文件中查找行号与匹配片段，始终指定尽量精准的 include 和 path
- **Read**：只用于局部读取文件，始终设置合理的 limit（如 200-500 行）和合适的偏移
- **对于任何可能很大的文件**：
  - 禁止直接从头读到尾
  - 始终先通过索引、目录、关键词等方式缩小范围后再读

---

## 本Skill内置工具

### 工具目录结构

```
rag-skill/
├── tools/
│   └── cli/
│       └── markitdown-convert.py    # 多格式文档转Markdown工具
└── scripts/
    └── convert_pdf_to_images.py     # PDF转图片脚本
```

### 1. markitdown-convert.py — 多格式文档转Markdown

**位置**：`[SKILL_DIR]/tools/cli/markitdown-convert.py`

**功能**：将PDF、DOCX、XLSX、PPTX等格式文档转换为Markdown格式

**调用方式**：
```bash
# 基本用法
python [SKILL_DIR]/tools/cli/markitdown-convert.py <input_file> [output_file]

# 示例：转换PDF
python [SKILL_DIR]/tools/cli/markitdown-convert.py "[DOCS_DIR]/document.pdf" "[DOCS_DIR]/output.md"

# 示例：转换Excel
python [SKILL_DIR]/tools/cli/markitdown-convert.py "[DATA_DIR]/report.xlsx" "[DATA_DIR]/report.md"
```

**支持格式**：
- PDF（文本型，非扫描版）
- DOCX（Word文档）
- XLSX（Excel表格）
- PPTX（PowerPoint演示文稿）
- HTML、CSV、JSON等

**使用时机**：
- 需要将文档转换为Markdown进行检索时
- 需要提取文档中的表格和文本时
- 处理多种格式文档时

**前置条件**：
```bash
pip install 'markitdown[all]'
```

**输出格式**：JSON，包含 `success`、`text_content`、`char_count` 等字段

### 2. convert_pdf_to_images.py — PDF转图片

**位置**：`[SKILL_DIR]/scripts/convert_pdf_to_images.py`

**功能**：将PDF页面转换为图片格式

**调用方式**：
```bash
# 查看脚本帮助
python [SKILL_DIR]/scripts/convert_pdf_to_images.py --help
```

**使用时机**：
- 需要提取PDF中的图表进行分析时
- 扫描版PDF需要OCR处理时
- 需要可视化PDF页面时

---

## 回答风格与错误处理

- 回答风格
  - 尽量用用户提问的语言（中文/英文）作答。
  - 先给出结论，再给出简要依据。
  - 如需要，可在后面列出引用的文件和大致位置，例如：
    - 来源：design/api_gateway.md 第 100 行附近
    - 来源：reports/2023_Q1_sales.xlsx Summary 工作表
- 信息缺失或不确定时
  - 明确说明在当前知识库中没有找到完全匹配的信息或只能部分回答。
  - 不臆造事实。
  - 提示用户可以如何帮助缩小范围：
    - 指定更具体的目录/文件
    - 提供更精确的关键词或字段名
    - 指定时间/版本范围


 