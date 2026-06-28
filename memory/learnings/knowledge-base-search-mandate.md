---
name: knowledge-base-search-mandate
description: 规则+钩子写了但 Claude 不遵守的根因 — 行为层缺少知识库强制检索步骤。设计前必须搜索/读取 knowledge/ 示例代码。
metadata:
  type: feedback
  related: [[00-core-rules]] [[15-requirements-gate]] [[01-hdl-rules]] [[hdl-coding-skill]]
---

# 知识库强制检索 — 设计前必须参考示例

**Why**: 用户写了很多规则和 hook，但 Claude 做项目时仍然不参考知识库的示例代码，不遵守 hdl-coding 规则，不澄清模糊点。
根因：规则存在于文件中，但行为层缺少一个**强制步骤**——"设计前必须先搜索知识库、读取示例、对标分析"。
Claude 的"先做再说"惯性太强，没有明确的步骤 0，就会跳过知识库直接写代码。

**How to apply**: 收到任何新项目/新模块需求后，执行以下强制流程，不可跳过：

```
步骤 0: 搜索知识库 (MUST)
  → Glob knowledge/**/*.sv, .v, .py
  → Grep 功能/协议关键词搜 knowledge/
  → Read 最相关的 2-5 个示例全文
  → Read hdl-coding SKILL.md + RTL_DESIGN_RULE.md
  → 输出「示例分析」（命名/结构/接口/位宽模式 + 引用来源）

步骤 1: 设计方案 (MUST)
  → 接口定义 + 微架构 + 示例对标 + 规则对标
  → 有模糊点 → 输出「待澄清清单」一次性问完
  → 用户确认后 → 编码

步骤 2: 编码自检 (MUST)
  → ri_/ro_/三段式FSM/同步复位/无锁存器/位宽匹配
  → 每项对标示例代码具体行 + hdl-coding 具体条款
```

## 为什么之前的规则和 Hook 不够

| 做了什么 | 效果 | 为什么不够 |
|:---------|:-----|:----------|
| 写了 rules/01-hdl.md | 定义了 ri_/ro_/FSM 等规范 | L1 优先级，只在涉及 .sv/.v 时加载，且只描述"应该怎样"，没描述"怎么保证会做" |
| 写了 rules/15-requirements-gate.md | 定义了六维澄清框架 | 管住了启动前的粗粒度澄清，但没管住编码时的细粒度范式对标 |
| 写了 rules/16-verification-quality-gate.md | 定义了验证质量要求 | 管住了 TB 的质量，但没管住 RTL 代码与示例代码的风格一致性 |
| 加了 Hook exit 2 | 硬阻断未完成门禁的 Write | 管住了"能不能写"，管不住"写成什么样" |
| 写了 CLAUDE.md 行为指令 | 要求遵守规则 | context 压力大时被忽略，没有"不遵守的可见后果" |

## 关键发现

**知识库里有大量示例代码（`knowledge/primary/domains/fpga/examples/`、`skills/hdl-coding/references/`），但 Claude 设计前从不搜索和读取。**

解决方案：在 CLAUDE.md 和 00-core.md 中，将"步骤 0：搜索知识库"设为铁律级强制步骤。
不搜索 → 不许设计。不读取示例 → 不许编码。
