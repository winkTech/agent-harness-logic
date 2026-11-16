---
name: knowledge-map-compliance
description: 新增知识库内容必须符合地图引导要求 — frontmatter/场景/标签三同步
metadata:
  type: learning
---

# 知识库新增规则：三同步原则

> 2026-06-05 确立，伴随 SCENE_CARDS.md + TAG_INDEX.md 知识地图上线

新增知识库内容（文档、技能、工具）时，必须同步维护知识地图的三个入口：

## 三条硬性规则

### 1. Frontmatter 必填

每个新 `.md` 文档必须包含 YAML frontmatter：

```yaml
---
title: "文档标题"
tags: [领域, 算法, 类型]     # 从 TAG_INDEX.md 选用已有标签
description: "一句话摘要"    # 用于检索时快速确认相关度
related: [关联文档路径]       # 同算法/同域的其他文档
---
```

**禁止**无 frontmatter 的裸文档。

### 2. 场景卡片同步

新内容如果属于现有 10 个场景之一，必须更新 SCENE_CARDS.md 中对应卡片的文档列表。

如果新内容不属于任何现有场景 → 评估是否需要新增第 11 号场景卡片。新场景必须：
- 有明确的触发词（用户说什么时该走这个场景）
- 有核心标签组合
- 文档数 ≥ 2

### 3. 标签索引同步

新增标签必须在 TAG_INDEX.md 中注册。遵循现有分类：
- `域 (domain)` — comm / fpga / python / matlab
- `算法 (algo)` — ofdm / rrc / channel-est / sync / ldpc
- `标准 (standard)` — lte / 5g-nr / 802.11n / oran
- `接口 (interface)` — jesd204b / pcie / aurora / selectmap
- `工具 (tool)` — vivado / tcl / timing / matlab / python
- `文档类型 (type)` — spec / fixed-point / resource / rtl / impl / guide / uvm / cosim

没有合适标签 → 先扩展 TAG_INDEX.md 的分类，再添加新标签。

## 示例：新增 DDR MIG 文档

```yaml
# knowledge/primary/domains/fpga/ddr-mig-guide.md
---
title: "DDR MIG 高速内存接口"
tags: [fpga, ddr, mig, high-speed-io, guide]
description: "DDR4 MIG 控制器配置、时序校准、带宽计算"
related: [pcie-guide.md, rfsoc-guide.md, vivado-guide.md]
---
```

然后：
1. SCENE_CARDS.md 场景 03（高速接口）添加到文档列表
2. TAG_INDEX.md 的 `接口 (interface)` 分类新增 `ddr` 行

## 为什么

之前的知识库有 34 篇文档缺失 frontmatter，导致标签检索失效。新规则确保每一篇新文档从入库第一天就可被知识地图精准定位。

**How to apply:** 每次新建知识文档时，先检查 SCENE_CARDS.md + TAG_INDEX.md 确定位置，再动笔。
