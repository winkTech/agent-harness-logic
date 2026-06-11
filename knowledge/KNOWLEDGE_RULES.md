---
name: knowledge-rules
description: 知识库管理规则 — 入库 SOP、蒸馏流程、知识地图维护、Frontmatter 标准
metadata:
  type: reference
  domain: meta
tags: [rules, governance, sop, knowledge-base]
---

# 📚 知识库管理规则

> 统一管理 knowledge/ 的知识生命周期：入库 → 蒸馏 → 索引 → 维护。
> 与 [MEMORY_RULES.md](../memory/MEMORY_RULES.md) 互补：memory/ 管**经验教训**，knowledge/ 管**领域知识**。

---

## 一、知识库结构

```
knowledge/
├── INDEX.md                 # 主索引 (自动计数)
├── SCENE_CARDS.md           # 场景入口卡 (11 个场景)
├── TAG_INDEX.md             # 标签索引 (7 维分类)
├── KNOWLEDGE_RULES.md       # 本文件
├── DEDUP-MAP.md             # 鸢尾花书去重映射
├── primary/                 # 精炼知识文档 ★ 核心目录
│   ├── domains/comm/        # 通信算法 (51 篇)
│   ├── domains/fpga/        # FPGA 设计 (25 篇)
│   ├── domains/python/      # Python 工具
│   ├── domains/matlab/      # MATLAB 模型
│   ├── cross-project-experience.md
│   └── knowledge-graph.md   # 知识图谱 (见第六节)
├── references/              # 引用文档 (harness 架构/工具链说明)
├── docs/templates/          # 文档模板 (UVM/CI/PRD/Spec)
├── python-basics/           # 鸢尾花书蒸馏: Python 编程 (22 卡片)
├── math-foundation/         # 鸢尾花书蒸馏: 微积分/优化 (9 卡片)
├── linear-algebra/          # 鸢尾花书蒸馏: 线性代数 (5 卡片)
├── probability-statistics/  # 鸢尾花书蒸馏: 概率论 (3 卡片)
├── data-viz/                # 鸢尾花书蒸馏: 可视化 (1 卡片)
├── archive/sources/         # 书籍全文提取 (39 篇, 按需搜索)
└── source/datasheets/       # 原始 PDF (35 个, 仅供提取引用)
```

---

## 二、Frontmatter 标准 [MUST]

> 所有 `knowledge/` 下的 .md 文件（archive/sources/ 例外）必须包含 YAML frontmatter。

### 2.1 标准模板

```yaml
---
name: <短横线命名，如 ofdm-algorithm-spec>
description: <一句话描述，不超过 120 字>
metadata:
  type: <algo | design-guide | reference | tutorial | template | book-note>
  domain: <comm | fpga | python | math | meta>
tags: [<标签1>, <标签2>, ...]    # 参见 TAG_INDEX.md 的标签体系
related: [<相关文档名>, ...]       # 可选：相关文档链接
---
```

### 2.2 type 取值

| type | 适用场景 | 示例 |
|:-----|:---------|:-----|
| `algo` | 算法规格/定点/实现报告 | `ofdm/algorithm_spec.md` |
| `design-guide` | 设计指南/最佳实践 | `fpga-design-guide.md` |
| `reference` | 引用/概述文档 | INDEX.md, references/\* |
| `tutorial` | 教程/入门指南 | `vivado-guide.md` |
| `template` | 文档模板 | `docs/templates/prd.md` |
| `book-note` | 书籍蒸馏卡片 | 鸢尾花书系列 |

### 2.3 自动检查

```bash
# 检查所有 .md 文件的 frontmatter 覆盖率
node engine/scripts/kb-stats.cjs --check

# 检查 INDEX.md 计数是否过时
node engine/scripts/kb-stats.cjs --check-only
```

---

## 三、知识入库 SOP

> 当需要向知识库添加新知识时，按以下流程执行。

### 3.1 入库流程

```
Step 1: 定位
  └─ 判断知识类型 → 确定目标目录
    ├─ 通信算法 → primary/domains/comm/<topic>/
    ├─ FPGA 设计 → primary/domains/fpga/<topic>.md
    ├─ 工具/平台 → primary/domains/<tool>.md
    ├─ 架构/引用 → references/<topic>.md
    └─ 模板 → docs/templates/<type>/<name>.md

Step 2: 查重
  └─ 搜索知识库确认无重复
    ├─ grep -ri "<keyword>" primary/
    └─ 检查 DEDUP-MAP.md (鸢尾花书)

Step 3: 撰写
  └─ 按 frontmatter 标准 + 领域内容规范编写
    ├─ 通信算法 → 必须含: 背景/算法描述/数学公式/接口定义/参考
    ├─ FPGA 设计 → 必须含: 适用场景/架构图/代码示例/约束/时序
    └─ 引用文档 → 必须含: 来源/版本/适用范围

Step 4: 索引
  └─ 更新相关索引
    ├─ 新主题 → 添加 SCENE_CARDS.md 场景卡片
    ├─ 新标签 → 更新 TAG_INDEX.md 标签条目
    ├─ 新文件 → 更新 INDEX.md 分类列表
    └─ 知识地图 → 更新 knowledge-graph.md

Step 5: 验证
  └─ node engine/scripts/kb-stats.cjs --check
```

### 3.2 文件命名规范

| 类型 | 格式 | 示例 |
|:-----|:-----|:------|
| 算法文档 | `<algo>-<aspect>.md` | `ldpc-encoding-spec.md` |
| 设计指南 | `<domain>-<topic>.md` | `fpga-timing-guide.md` |
| 引用文档 | `<topic>.md` | `memory-system.md` |
| 模板 | `<type>.md` | `prd.md`, `spec.md` |

### 3.3 质量标准 [MUST]

- ✅ 每篇文档至少解决一个具体问题
- ✅ 包含可操作的代码/配置/命令示例
- ✅ 标注来源和适用范围
- ❌ 不包含完整的项目代码（引用 docs/templates/ 即可）
- ❌ 不包含原始 PDF 全文（提取到 archive/sources/）
- ❌ 不包含个人经验记忆（写到 memory/learnings/）

---

## 四、文档蒸馏流程

> 将原始资料（PDF/书籍/论文/网页）转化为精炼知识文档的标准方法。

### 4.1 蒸馏五步法

```
Step 1: 扫描 → 阅读目录/摘要，确定知识价值
Step 2: 提取 → 只摘录与目标领域相关的部分
Step 3: 重构 → 用自己的话重述，附加 RTL/代码示例
Step 4: 压缩 → 去除冗余，保留精华。目标: 原始大小 < 5%
Step 5: 索引 → 更新 SCENE_CARDS + TAG_INDEX + INDEX + 知识地图
```

### 4.2 蒸馏率标准

| 来源类型 | 目标压缩率 | 示例 |
|:---------|:----------|:-----|
| 技术书籍 (300-800页) | 原始大小的 < 0.1% | 609MB → 200KB (99.97%) |
| 论文 (10-30页) | < 5% | — |
| 应用笔记 (AN) | < 10% | — |
| 网页/博客 | < 30% | — |
| 数据手册 | < 1%（只提取接口/时序） | — |

### 4.3 蒸馏文档结构

每篇蒸馏文档应包含：

```markdown
---
name: <topic>-notes
description: <来源> 的精华提取
metadata:
  type: book-note
  domain: <domain>
source: <原始来源路径/URL>
original_size: <原始大小>
compression_ratio: <压缩率>
---

# <主题> — 笔记

## 核心概念
<!-- 3-5 句话概括 -->

## 关键公式/算法
<!-- 数学描述或伪代码 -->

## 与 RTL/FPGA 的关联
<!-- 如何映射到硬件设计 -->

## 参考
<!-- 原文章节/页码跳转 -->
```

### 4.4 批处理蒸馏

对于多个相关源文件（如同一本书的不同章节）：

1. 先建立 `DEDUP-MAP.md` 去重映射
2. 按主题分组提取
3. 合并重复内容，保留最系统的版本
4. 其他版本标注 `→ 详见 [主来源]`

---

## 五、知识图谱维护

> `primary/knowledge-graph.md` 记录知识库中所有文档的关联关系。

### 5.1 图谱结构

```yaml
知识图谱:
  通信算法:
    OFDM:
      相关: [RRC, ChEst, Sync, WiFi]
      前置: [digital-comm-basics]
      后置: [ofdm-rtl, ofdm-fixed-point]
    LDPC:
      相关: [5G NR, WiFi, BCC]
      前置: [channel-coding-basics]
    WiFi:
      包含: [phy-layer, mac-layer, ldpc-bcc-encoding]
      相关: [OFDM, LDPC]
   FPGA:
    Timing:
      相关: [vivado-guide, jesd204b-guide]
      前置: [fpga-design-guide]
    JESD204B:
      相关: [pcie-guide, aurora-guide]
      前置: [high-speed-io-basics]
```

### 5.2 更新时机

- **文档新增时**: 添加节点和出边
- **文档更新时**: 检查关联关系是否变化
- **每季度**: 全量审查图谱完整性

### 5.3 交叉链接标准

```markdown
<!-- 在文档中使用 [[wiki-link]] 语法标注关联 -->
参考: [[ldpc-encoding-spec]], [[ofdm-algorithm-spec]]
前置知识: [[fpga-design-guide]]
```

所有 `[[wiki-link]]` 会被 `engine/scripts/resolve-wiki-links.cjs` 自动解析。

---

## 六、知识库生命周期

### 6.1 定期维护

| 频率 | 任务 | 执行者 |
|:----|:-----|:-------|
| **每次修改后** | `node engine/scripts/kb-stats.cjs --check` | 提交前 hook |
| **每周** | 审查新入库知识，更新 SCENE_CARDS | 人工 |
| **每月** | 全量 frontmatter 审查 + 图谱更新 | 人工或 Workflow |
| **每季度** | 清理过时文档，归档到 archive/ | 人工 |

### 6.2 版本标注

对于可能过时的知识文档，在 frontmatter 中添加：

```yaml
status: stable | deprecated | superseded-by-<name>
reviewed_at: 2026-06-11
```

`deprecated` 状态的文档保留 90 天后移到 `archive/`。

### 6.3 清理标准

| 条件 | 操作 |
|:----|:-----|
| status=deprecated 超过 90 天 | → archive/ |
| 内容已被新的文档完全覆盖 | → archive/ + 更新 DEDUP-MAP |
| 空文件/测试产物 | → 直接删除 |
| 重复文档 | → 合并到主来源 → archive/ |

---

## 七、验证与自动化

### 7.1 Hook 集成

```
SessionStart → kb-stats.cjs --check     (INDEX 计数过期告警)
PreToolUse   → memory-retrieve-hook.cjs  (知识检索注入, 已实现)
PostMessage  → cross-link-memory.cjs     (挫败→知识检索, 已实现)
```

### 7.2 日常命令

```bash
# 统计知识库健康状况
node engine/scripts/kb-stats.cjs

# 检查 INDEX.md 是否需要更新 (退出码 1 = 需要)
node engine/scripts/kb-stats.cjs --check

# 检索知识库
node engine/scripts/memory-retrieve-hook.cjs    # 自动 (PreToolUse)
bash engine/scripts/memory-retrieve.sh <query>   # 手动

# 检查 wiki-link 健康度
node engine/scripts/resolve-wiki-links.cjs --check
```

### 7.3 健康标准

| 指标 | 健康值 | 警戒线 |
|:----|:------:|:------:|
| Frontmatter 覆盖率 | ≥ 90% | < 80% |
| INDEX.md 计数误差 | 0 | > 5 |
| Wiki-link 断裂率 | 0 | > 5% |
| 构建产物/空文件 | 0 | > 10 |
| 过时文档 (deprecated >90d) | 0 | > 3 |

---

## 附录：快速参考

```bash
# 知识入库完整命令链
cd knowledge/
touch primary/domains/<domain>/<topic>.md    # 1. 创建文件
# 编辑 frontmatter + 内容                      # 2. 撰写
# 更新 SCENE_CARDS.md / TAG_INDEX.md           # 3. 索引
# 更新 INDEX.md 分类列表                        # 4. 主索引
# 更新 knowledge-graph.md                       # 5. 图谱
node ../engine/scripts/kb-stats.cjs --check    # 6. 验证
git add -A && git commit -m "docs(kb): ..."    # 7. 提交
```

> 创建时间: 2026-06-11
> 维护者: Claude Code + 人工审查
> 关联: [MEMORY_RULES.md](../memory/MEMORY_RULES.md)
