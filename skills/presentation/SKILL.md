---
name: presentation
description: 图表与 Office 文档生成 — 架构图(Mermaid/Draw.io) + HTML 幻灯片 + PPT(x) + Excel(xlsx)
version: 1.0.0
model: sonnet
invoked_by: both
user_invocable: true
tools: [Read, Write, Edit, Bash, Glob, Grep]
---

# Presentation

图表、幻灯片和 Office 文档生成。按输出类型选择模式：

| 模式 | 命令 | 工具链 | 适用 |
|:----|:-----|:-------|:-----|
| **架构图** | `diagram:` | Mermaid / Draw.io XML | 系统架构/数据库/组件/时序图 |
| **HTML 幻灯片** | `slides:` | HTML+CSS+JS 模板 | 分享稿、技术演讲、小红书图文 |
| **PowerPoint** | `pptx:` | python-pptx | 正式演示文稿，含图表/表格 |
| **Excel** | `xlsx:` | openpyxl / xlsxwriter | 数据报告、表格输出 |

---

## 模式 1：架构图

支持两种工具：

| 工具 | 适用复杂度 | 说明 |
|:----|:---------|:------|
| **Mermaid** | 简单-中等 | 流程图、时序图、类图、状态图 |
| **Draw.io** | 复杂 | 精细控制的大型架构图，导出 HTML |

**准则**: 不超过 200 节点，先高层总览后细节分解。

## 模式 2：HTML 幻灯片

纯静态 HTML 演示文稿。一个主题文件统一视觉风格，CDN 字体。

```bash
npx skills add https://github.com/lewislulu/html-ppt-skill  # 首次安装
```

**功能**: 多种布局、入场动画、键盘导航、小红书图文支持。

## 模式 3：PowerPoint

使用 python-pptx 生成 `.pptx` 文件。

**准则**:
- 使用占位符形状而非文本框
- 所有尺寸用 `Pt()` / `Emu()` 单位
- 使用母版幻灯片保持品牌一致性
- 图表/表格/条件格式全部支持

## 模式 4：Excel

使用 openpyxl（读/改已有文件）和 xlsxwriter（新建高级格式）。

**准则**:
- 同一文件不要混用 openpyxl 和 xlsxwriter
- xlsxwriter 必须 `close()` 才能刷新输出
- 使用命名样式跨表保持格式一致
- 支持图表、条件格式、公式

## 关联 Skill

- [doc-gen](../doc-gen/SKILL.md) — 配套的文档生成
