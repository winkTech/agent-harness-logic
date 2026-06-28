# rules/ 目录

> 5 个核心规则 + archive/ 低频规则。**规则是检查点的输入，不是背景噪音。**

## 核心规则

| 文件 | 优先级 | 内容 | 加载条件 |
|:-----|:-------|:-----|:---------|
| `00-core.md` | L0 | 铁律 + 四检查点 + Lint First + 验证闭环 | 始终 |
| `01-hdl.md` | L1 | HDL 五条红线 + 命名 + 模板参考 | .sv/.v |
| `02-python.md` | L1 | Python ruff + 硬件调试 | .py |
| `03-gates.md` | L0 | 两道门禁（需求澄清 + 验证质量）含触发/退出/阻断/hook | 始终 |
| `04-git.md` | L2 | Git 提交/分支规范 | commit/push |

## archive/ — 低频规则（按需 Read，不自动加载）

| 文件 | 场景 |
|:-----|:-----|
| `03-debugging.md` | 仿真报错/波形不对 |
| `04-security.md` | auth/token/encrypt |
| `05-workflow-trigger.md` | 关键词→工作流映射（已集成到 CLAUDE.md） |
| `06-cognition.md` | 7 种推理模式 |
| `07-system.md` | 安装/下载 |
| `08-constraints.md` | Golden Model 保护 |
| `09-search-tools.md` | 代码搜索优先级 |
| `10-drawing.md` | 画图/架构图 |
| `12-tdd.md` | TDD/测试驱动 |
| `13-context-management.md` | 上下文管理（已集成到 CLAUDE.md） |
| `14-fix-in-place.md` | 文件变体禁止（已由 hook 执行） |

## L0 始终加载量

```
CLAUDE.md    138 行
00-core.md    62 行
03-gates.md   63 行
─────────────────
总计         263 行  (原 ~950 行，精简 72%)
```
