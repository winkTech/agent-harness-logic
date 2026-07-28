---
name: rag-skill
description: 本地 FPGA/通信知识库检索问答。用户要求查知识库、参考既往设计/调试经验、比较方案或定位本地技术文档时使用；按意图路由、标签和标题锚点渐进加载，避免全库 grep 与过时行号。
---

# 知识库检索 v2

## 核心流程

```
用户问题
    │
    ▼
1. 意图识别 ─────────────────────────────┐
    │  设计/调试/学习/集成/选型/其他      │
    ▼                                     │
2. 加载 SCENE_CARDS.md                    │
    ↓ 匹配场景编号                         │
    ▼                                     │
3. 加载 TAG_INDEX.md                      │
    ↓ 组合标签过滤                         │
    ▼                                     │
4. 加载目标文档前端摘要（frontmatter）     │
    ↓ 确认相关度                           │
    ▼                                     │
5. 加载目标文档全文（按需分段）           │
    │                                     │
    ├─ 匹配成功 → 回答                    │
    ├─ 不匹配 → 回退 grep primary/        │
    └─ 仍不匹配 → 告知用户未找到          │
```

---

## 1. 意图识别

根据用户问题前几个词/语境，判断任务类型：

| 意图 | 触发词 | 目标场景 |
|:----|:-------|:---------|
| **设计** | 设计、实现、编解码器、OFDM、LDPC、滤波器、同步 | 场景 01 / 09 |
| **调试** | 调试、不通过、错误、违例、仿真失败、ILA、EVM | 场景 02 / 07 |
| **集成** | 集成、对接、PCIe、Aurora、JESD204B、RFSoC | 场景 03 |
| **学习** | 学习、理解、概述、原理、NR、ORAN、通信系统 | 场景 04 |
| **验证** | UVM、验证、testbench、覆盖率、仿真 | 场景 06 |
| **贯通** | cosim、MATLAB→RTL、向量、对比、golden | 场景 05 |
| **自动化** | Tcl、脚本、编译、构建、CI、vivado | 场景 08 |
| **选型** | 选型、对比、区别、vs、vs、还是 | 场景 10 |
| **其他** | 不匹配以上任何 → 走 TAG_INDEX 或回退 grep | 全部 |

---

## 2. 渐进式加载协议

不再一次加载 INDEX.md。严格按层级加载，**禁止全量读取 SCENE_CARDS.md 或 TAG_INDEX.md**：

```
L0: 用 rg 定位 SCENE_CARDS 的“场景总览”和各场景标题
    ↓ 选择场景
L1: 从匹配标题读取到下一个同级标题（单张卡片, ~900 tok）
    ↓ 提取标签
L2: TAG_INDEX 相关标签区 (~600 tok)
    ↓ 定位文档
L3: 目标文档 frontmatter (~100 tok/篇) → 确认相关度
    ↓ 确认
L4: 目标文档全文 (500-3k tok)
    ↓ 不匹配
L5: grep primary/ (全文扫描, 最后手段)
```

**标题锚点加载**（文档增删内容后仍稳定）:
```powershell
rg -n "^## (场景总览|[0-9]{2} )" engineering-assets/knowledge/SCENE_CARDS.md
```

先读取“场景总览”标题到第一个编号场景；选择场景后，从对应 `## NN` 标题
读取到下一个 `##` 标题之前。`offset/limit` 必须根据本次 `rg -n` 结果计算，
不得保存或复用历史行号。

**预算控制**：
- 单次检索总消耗 ≤ 5,000 tok（含已读文档）
- L0+L1+L2 三步必须 ≤ 2,000 tok（超出说明场景匹配错，回退重选）
- 超过 5,000 tok 仍未找到 → 直接回退到 grep
- grep 超过 3 次命中无结果 → 告知用户"未找到相关信息"

---

## 3. 标签优先检索

替代旧版无差别 grep。步骤：

### 3.1 定位场景

从 SCENE_CARDS.md 找到匹配的任务场景，读取该场景的"核心标签"字段：

```
例：用户问"设计 LDPC 编解码器"
→ 匹配场景 09
→ 核心标签: ldpc + spec + rtl + 5g-nr
```

### 3.2 标签交叉过滤

从 TAG_INDEX.md 按标签组合找出目标文档：

```
例：tag:ldpc + tag:spec
→ ldpc/algorithm_spec, encoding_spec

例：tag:fpga + tag:high-speed-io + tag:pcie
→ fpga/pcie-guide
```

### 3.3 加载摘要确认

读目标文档的 frontmatter（前三行）确认是否真正匹配。只暴露 `title:`, `description:`, `tags:` 三字段。

---

## 4. 回退流程

当标签定位失败或文档内容不匹配时：

```
1. grep 场景内文档
   grep -rl "keyword" engineering-assets/knowledge/primary/domains/<scene-dir>/

2. grep 全 primary
   grep -rl "keyword" engineering-assets/knowledge/primary/

3. grep archive 源文档
   grep -rl "keyword" engineering-assets/knowledge/archive/sources/

4. 告知用户未找到
   → "知识库中未找到相关信息"
   → 提示尝试其他关键词
   → 或提供相关主题建议
```

---

## 5. 文件类型处理

### Markdown (primary/)
- 先用 TAG_INDEX.md 定位 → 读 frontmatter → 读全文
- 全文用 Read tool，大文件用 offset/limit 分段

### PDF
→ 参见 `references/pdf_reading.md`
- 使用 MCP pdf 工具

### Excel
→ 读取方法参见 `references/excel_reading.md`，分析方法参见 `references/excel_analysis.md`
- 使用 Python pandas 或 markitdown-converter

---

## 6. 注意事项

- **严禁一次加载完整 SCENE_CARDS.md 或 TAG_INDEX.md** — 仅加载匹配场景/标签的部分
- **grep 是最后手段** — 先走场景→标签→摘要三级过滤
- **每次检索最多 5 轮交互** — 超过即停止并告知用户
- **不确定时直接说不知道** — 不编造
- **大文件必须分段读取** — 禁止 Read 整个 archive 文件

---

## 关联 Skill

- [code-search](../code-search/SKILL.md) — 代码库搜索
- [hdl-coding](../hdl-coding/SKILL.md) — HDL 编码

## 参考文档

| 文档 | 内容 |
|:----|:-----|
| `references/pdf_reading.md` | PDF 读取流程 |
| `references/excel_reading.md` | Excel 读取方法（pandas 读表/选列/大文件分批） |
| `references/excel_analysis.md` | Excel 分析方法（过滤/分组聚合/统计） |
| `scripts/convert_pdf_to_images.py` | PDF 转图片（扫描版 OCR / 图表提取） |
