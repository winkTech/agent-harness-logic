---
name: desensitization-rule
description: 全仓库脱敏规则 — 所有 git 追踪文件必须使用占位符替代个人/本地信息
metadata:
  type: learning
---

# 仓库脱敏规则

> 目标：保证仓库可共享、可发布，任何 git 追踪文件中不含个人身份或环境特有信息。

## 必须脱敏的模式

| 模式 | 示例 | 替换为 |
|------|------|--------|
| 用户名 | `Lihan`, `Lihang` | `[AUTHOR]` |
| 用户主目录路径 | `C:\Users\Lihan\`, `/c/Users/Lihan/`, `C:/Users/Lihan/` | `[HOME_DIR]` 或上下文相关占位符 |
| Claude 配置目录 | `C:\Users\Lihan\.claude\` | `[CLAUDE_HOME]` |
| 插件缓存路径 | `C:\Users\Lihan\.claude\plugins\cache\...` | `[PLUGINS_CACHE]/...` |
| Skill 工具路径 | `C:/Users/Lihan/.claude/skills/rag-skill/...` | `[SKILL_DIR]/...` |
| 本地文档库 | `D:\Papers\`, `D:\docs\`, `D:\data\` | `[PAPERS_DIR]`, `[DOCS_DIR]`, `[DATA_DIR]` |
| 机器特定路径 | `J:\basic_verilog\`, `E:\fpga_dsp_example\` | `[PROJECT_DIR]`（仅限自有代码；外部资料原文保留） |
| API Token / 密钥 | `your_bot_token_here`（占位符 OK）, 真实 token | `[TOKEN]` 或直接使用 `your_xxx_here` |
| **工具具体版本号** | `Vivado 2023.1`, `ModelSim 10.6c`, `MATLAB R2022a` | 写**怎么查**（`eda-detect.cjs --json` / `--version`），不写值 |
| **工具安装路径** | `C:\Xilinx\Vivado\<ver>\bin`, `C:\Program Files\MATLAB\<ver>` | `[EDA_ROOT]` / `[MATLAB_ROOT]`，或让脚本从 PATH 解析 |

> 工具版本和安装路径是**双重问题**：既是机器特有信息，又会随升级立刻过期。
> 文档里固化一个版本快照，等于埋了一颗到期就误导人的雷。需要版本时一律现查。
> 例外：**问题记录**（错误复盘、bug 归因）里为了还原现场可以写具体版本，
> 但要注明观测日期，且不要作为规范性结论被别处引用。

## 占位符约定

全部采用 `[UPPERCASE_NAME]` 格式，下划线分隔：
- `[AUTHOR]` — 作者/版权人
- `[CLAUDE_HOME]` — Claude 根目录
- `[PLUGINS_CACHE]` — 插件缓存目录
- `[SKILL_DIR]` — Skill 工具基目录
- `[PAPERS_DIR]` / `[DOCS_DIR]` / `[DATA_DIR]` — 数据目录
- `[HOME_DIR]` — 用户主目录（通用 fallback）

## 不修改的范畴

- **第三方 vendored 代码**：`engineering-assets/reference-assets/vendor/*`（basic_verilog / picorv32 /
  verilog-pcie / async_fifo / r22sdf / axis_udp 等上游 OSS）。其中的作者邮箱、`/home/<name>/`
  构建路径、Quartus 报告里的机器路径**属于上游原文与署名**，改动会破坏溯源与许可归属。
  2026-07-27 扫描：385 条 email、12 条 nix 路径全部落在此范围内，判定为**期望内**。
- **子模块**：`knowledge/primary/domains/fpga/examples/basic_verilog-master/` 等独立仓库
- **第三方 marketplace 代码**：`plugins/marketplaces/*`
- **本规则文件自身**：本文列举的模式示例必须保留原样，否则规则不可读
- **知识库原文引用**：`knowledge/archive/sources/*` 中的书籍原文（含有出版社联系方式等，属于原文内容）
- **已占位符化的模板**：`config.json` 中的 `"primaryApiKey": "any"` 等

## 新文件写入规则

1. 新建 git 追踪文件时，直接使用占位符替代个人/路径信息
2. 路径引用使用相对路径（相对于仓库根），或 `[SKILL_DIR]` 等占位符
3. 版权/作者字段使用 `[AUTHOR]`
4. 示例命令中的路径使用 `[DOCS_DIR]`, `[DATA_DIR]` 等

## 提交前检查

在 `git commit` 之前（或 pre-commit hook 中），执行：

```bash
# 检查用户名
git grep -c -i "lihan" -- ':!plugins/.cache-archive/*' ':!knowledge/archive/*' ':!knowledge/primary/domains/fpga/examples/basic_verilog-master/*' ':!plugins/marketplaces/*'

# 检查绝对路径（Windows）
git grep -n "[A-Z]:\\\\Users\\\\" -- ':!knowledge/archive/*' ':!knowledg/primary/domains/fpga/examples/basic_verilog-master/*' ':!plugins/marketplaces/*'
```

如果返回非零，说明有遗漏，必须修复后再提交。

## 自动生成文件处理

- 运行时自动生成的日志、缓存、清单文件（如 `plugins/.cache-archive/`），如果含个人路径，**不应入库**，而是加入 `.gitignore`
- 这些文件由运行环境自动产生，脱敏没有意义，隔离才是正确做法

## 例外处理

如果某个文件需要包含真实用户名或路径（如贡献者列表），必须在文件头用注释声明：

```
# DESENSITIZE-EXEMPT: 此文件需要真实署名，不适用脱敏规则
```

---

**Why:** 个人身份信息和本地路径会泄露隐私，且阻止仓库分享。脱敏是发布/协作的前置条件。

**How to apply:** 新建文件时用占位符替代；修改现有文件时 grep 检查模式；提交前 pre-commit 自动扫描。

**相关记忆:** [[lessons-summary]] 第 3 节安全考虑
