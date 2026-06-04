---
name: code-search
description: 统一代码搜索 — 工具执行(rg/pnpm) + 探索方法论(7阶段) + 语义搜索(向量嵌入)
version: 1.0.0
model: sonnet
invoked_by: user
user_invocable: true
tools: [Read, Write, Edit, Bash, Grep, Glob]
---

# Code Search

统一代码搜索能力，三个互补维度覆盖从"找一段代码"到"分析整个陌生代码库"的全场景。

---

## 快速选择

| 场景 | 用哪个 | 说明 |
|:----|:------|:-----|
| 日常搜代码 | `pnpm search:code "query"` | BM25+语义混合，紧凑有序结果 |
| 精确符号定位 | `rg -F "symbol"` | 最快、全匹配、确定性强 |
| 安全审计/完整扫描 | `Grep` (内置) / `rg` | 所有匹配都必须发现，不依赖排名 |
| 理解项目结构 | `pnpm search:structure` | 目录树 + 导出符号 + 依赖图 + Mermaid |
| 评估 Token 预算 | `pnpm search:tokens [path]` | 文件/目录 Token 估算 + 阅读建议 |
| 未知代码库 | `/code-search` → 7 阶段协议 | 渐进式探索，Token 预算 34K |
| 按意图找代码 | `/code-search semantic "query"` | 不知道函数名，只知功能描述 |

---

## 模式 1：工具执行 (ripgrep)

本仓库内日常搜索、编辑前定位、重构前影响面评估。

### 搜索命令速查

```bash
# 项目结构（先跑这个！）
pnpm search:structure

# 代码搜索（概念发现，排名结果）
pnpm search:code "authentication flow"

# Token 预算检查
pnpm search:tokens path/to/file.cjs

# 搜索 + 压缩 + 去重（大范围上下文用）
pnpm search:compress "how does routing work"

# 精确符号定位（编辑前必须）
rg -F "symbolName" -n

# 影响面评估（重构前）
rg -F "module-name" -c  # 每个文件的匹配数

# 文件类型过滤
rg "pattern" -tjs
rg "pattern" -tts
rg "pattern" -g "!node_modules/**"
```

### 编辑前必做流程

1. `pnpm search:structure` — 了解目录结构和导入热点
2. `pnpm search:tokens [path]` — 检查文件 Token 预算
3. `pnpm search:code "task"` — 找到相关文件
4. `rg -F "exactSymbol" -n` — 确认精确位置
5. 编辑 → 验证

### Raw ripgrep 高级用法

PCRE2 正则 (`rg -P`):
```bash
rg -P "error(?=.*critical)"     # 仅当后面有 critical 时匹配 error
rg -P "(?<!await )\b\w+\("      # 未被 await 的函数调用
```

---

## 模式 2：代码库探索 (Exploration Protocol)

**适用**: 陌生仓库 onboarding、第三方代码审查、快速理解未知系统。

**核心原则**: Never read a file to discover what's in it. 用搜索定位，读取仅用于确认。

**Token 预算**: 34K 总预算，60K 硬上限。

### 7 阶段流程

| 阶段 | Token | 操作 |
|:----|:-----|:-----|
| **0: 范围门禁** | ~500 | 估算 Token 预算 → 决定单 Agent / 多 Agent 分解 |
| **1: 结构扫描** | ~2K | 目录树 + 文件计数 + 语言识别（不读文件） |
| **2: Repo Map** | ~5K | README + 包清单 + 函数签名提取 + 导入图 |
| **3: 定向搜索** | ~5K | 搜索 API 端点 / 测试模式 / 数据库 / 配置 |
| **4: 选择性深读** | ~15K max 10 文件 | 每文件限 200 行，读后立即写摘要 |
| **5: 交叉引用** | ~5K | 追踪调用链、数据流、循环依赖 |
| **6: 综合检查点** | ~2K | 写完整报告到文件，返回路径 + 5 点摘要 |

### 多 Agent 分解（>100K Token 时）

1. Planner 按目录/职责拆 2-4 块
2. 每个 Researcher Agent 处理一块 → 写独立报告文件
3. Synthesizer Agent 读取所有报告 → 合并分析

---

## 模式 3：语义搜索 (Semantic Search)

**适用**: 忘记函数名、想找概念而非关键词、跨文件模式发现。

### 三种模式

| 模式 | 精度 | 速度 | 适用 |
|:----|:---:|:----:|:-----|
| **Hybrid（默认）** | 95% | <150ms | 通用搜索——语义+结构结合 |
| **Semantic-Only** | 85% | <50ms | 概念搜索，结构不重要 |
| **Structural-Only** | 100% | <50ms | 精确模式匹配（ast-grep） |

### 使用示例

```javascript
Skill({ skill: 'code-search', args: 'find authentication logic' });
Skill({ skill: 'code-search', args: 'semantic:database queries' });  // 语义模式
```

### 预置搜索

```bash
pnpm search:code "auth flow token refresh"         # 概念查询
pnpm search:code "TaskUpdate completed status"      # 混合查询
```

---

## 通用工作流模式

### 事故排查
```bash
pnpm search:code "task status not updating"   # 概念发现
rg -F "TaskUpdate(" -n                        # 精确定位
```

### 安全审计
```bash
rg -F "shell: true" -g "*.cjs"               # 完整扫描
rg "eval\(|new Function\("                    # 模式匹配
pnpm search:code "command injection"          # 概念发现（补充）
```

### 重构预备
```bash
pnpm search:structure                         # 热点识别
rg -F "module-path" -c                        # 影响面计数
pnpm search:code "task workflow"              # 语义变体发现
```

---

## 铁律

1. **编辑前先跑 `search:structure`** — 不先了解目录布局和导入热点，编辑就是盲改。
2. **安全审计必须用 `rg`/`Grep` 做完整扫描** — hybrid 搜索只返回 top-N 排名结果，审计要求全覆盖。
3. **编辑前必须用 `rg -F` 确认精确符号位置** — 语义搜索可能匹配到相似命名，实际编辑时改错文件。
4. **陌生代码库必须用 7 阶段协议** — 禁止在没完成 Phase 3 搜索前进入深读阶段。
5. **多阶段探索中，每阶段写完立即写报告到文件** — 原始工具输出堆积在上下文会导致"中部迷失"。
6. **超过 60K Token 时必须调用 `context-compressor`** — 不是"等超出再处理"，而是在边界时触发。
7. **语义搜索必须使用有意义的自然语言查询** — 单个关键字或代码片段做语义搜索效果很差。

## 反模式

| 反模式 | 正确做法 |
|:------|:---------|
| 用 hybrid 搜索做安全审计 | 用 `rg`/`Grep` 做全覆盖扫描，hybrid 仅用于概念补充 |
| 不跑 `structure` 直接编辑 | 先跑 `search:structure` 知道目录结构 |
| 编辑前不确认符号位置 | 用 `rg -F "exact"` 确认行号 |
| 陌生仓库直接深读文件 | 走 7 阶段协议，先搜索后读取 |
| 语义搜索用单个词查询 | 用自然语言描述功能 |

## 关联 Skill

- [debugging](../debugging/SKILL.md) — 调试验证发现的 Bug
- [agent-management](../agent-management/SKILL.md) — 多 Agent 分解编排
