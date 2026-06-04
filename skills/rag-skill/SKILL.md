---
name: rag-skill
description: 本地知识库检索问答。分层索引导航 → 按文件类型检索(grep/PDF/Excel) → 避免整文件加载。
version: 1.1.0
---

# 本地知识库检索

## 核心流程

```
1. 定位 knowledge/ 根目录
2. 读 INDEX.md 了解文档结构
3. 从 primary/ 优先检索（比 source/ 更结构化）
4. 按关键词 grep → 逐步深入（最多 5 次迭代）
5. 遇到 PDF/Excel → 先读 references/ 中的处理指南 → 再处理
```

## 公共检索原则

- **关键词选择**: 先宽后窄。第一轮用宽泛关键词，根据结果再精确化
- **grep 优先**: 用 `grep -r "keyword" --include="*.md"` 定位相关文档
- **多轮迭代**: 每轮基于上一轮结果调整方向，最多 5 轮
- **禁止整文件加载**: 大文件必须用 `Read` 的 offset/limit 参数分段读取
- **结果时先检查文件头部的 tags / metadata 确认相关度**

## 文件类型处理要点

### Markdown
- 优先用 `INDEX.md` 目录导航
- 用 `grep -r` 搜索关键词定位具体文档
- 相关度高才完整读

### PDF
→ 详细流程见 `references/pdf_reading.md`
1. 先读取 `rag-skill/references/pdf_reading.md` 学习处理方法
2. 使用 MCP pdf 工具打开和提取文本
3. 大 PDF（>10 页）用 pages 参数分段提取

### Excel
→ 详细流程见 `references/excel-reading.md`
1. 使用 `python3 -c "import pandas; ..."` 读取
2. 或 `markitdown-converter` 转换
3. 只读取需要的列和行

## 注意事项

- 不要在单次操作中加载整个目录
- 检索结果使用文件路径+关键词高亮的方式呈现
- 如果某轮检索没有结果，回溯到更宽的搜索词
- 不同文件格式使用对应的读取工具
- uncertain → 直接告诉用户"未找到相关信息"，不要编造

## 关联Skill

- [code-search](../code-search/SKILL.md) — 代码库搜索
- [markitdown-converter](../markitdown-converter/SKILL.md) — 文件转换

## 参考文档

| 文档 | 内容 |
|:----|:-----|
| `references/pdf_reading.md` | PDF 读取完整流程与 MCP 工具使用 |
| `references/excel-reading.md` | Excel 文件处理指南 |
