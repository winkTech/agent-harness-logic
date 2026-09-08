# M4：延迟预算分级硬限（M4a）与插件 Pack 结构（M4b）设计

## Metadata

| Field | Value |
|---|---|
| Date | 2026-09-08 |
| Status | M4a 已实现；M4b 目录重构**已于同日落地**（见 §2.5 实施记录） |
| Repository | `C:\Users\Lihan\.claude`（分支 `feat/logical-paradox-m1-state-dir`） |
| 决策来源 | 2026-09 会话收敛决策（M4a 档位 + M4b pack 划分），本文档为其首次落库固化 |
| 前序里程碑 | M1 状态分离（c619a47）、M2 Claude Code 插件形态（9fb59c8）、M3 传输层闭环（5357877） |

---

## 1. M4a：延迟预算分级硬限

### 1.1 决策（已收敛）

按同步热路径入口分级设定 **warm p95 硬限**，超标 exit 1：

| 档位 | 硬限 | 依据 |
|---|---|---|
| `preflight-router` | 200 ms | PreToolUse 关键路径，任何写操作前必经 |
| `postflight-router` | 250 ms | PostToolUse 结算路径 |
| `prompt-context` | 300 ms | UserPromptSubmit 注入路径 |
| 其余**同步**入口 | 500 ms | 兜底档 |
| async 入口 | 不计入 | 平台不阻塞等待，延迟不进热路径 |

档位与 async 判定的**单一来源**是 `engine/scripts/lib/hook-latency.cjs`（`budgetFor` / `registrationIndex` / `latencyScale`）；`env CLAUDE_HARNESS_LATENCY_SCALE` 整体放大预算（CI 用 3，容忍 runner 性能差异）。

与 `docs/rules/05-harness.md` §10 发布晋级门槛的关系（两套数字、两种用途，不得混用）：

| 数字集 | 用途 | 出处 |
|---|---|---|
| M4a 档位（200/250/300/500） | **per-entry 硬限**，`bench-hooks --sla` 与 CI 强制 | `lib/hook-latency.cjs` |
| Read ≤150 / Edit+Write Pre+Post ≤250 / 上下文 ≤600 字符 | shadow → enforce **晋级门槛** | `docs/rules/05-harness.md` §10 |

### 1.2 实现现状（2026-09-08 核实）

| 件 | 状态 | 证据 |
|---|---|---|
| 档位定义 + report() 预算判定 | **已提交**（b543355） | `engine/scripts/lib/hook-latency.cjs` |
| `bench-hooks --quick --sla` 档位硬门 | 工作树（README 未提交） | README.md +3 行 |
| SLA 契约测试 | 工作树未跟踪，**9/9 通过** | `test-hooks/hook-latency-sla-contract.test.cjs` |
| 门禁降级契约测试 | 工作树未跟踪，**7/7 通过** | `test-hooks/gate-load-degradation-contract.test.cjs` |
| CI 接线 | 工作树（+53 行） | `engine/scripts/harness-ci.cjs` |

**M4a 剩余动作**：在途变更提交（见 §4 未决问题 #1）。

---

## 2. M4b：插件 Pack 结构

### 2.1 决策（已收敛）

- skills / agents / MCP 按域拆为 `packs/fpga` 与 `packs/office` 两类 pack；
- **engine（hooks、diagnostics、状态层）驻留 Core**，不进任何 pack；
- 市场渠道**仅复制各插件自有目录**（per-plugin），Core 不随渠道分发。

### 2.2 tier 分类法（已铺，工作树未提交）

`engine/hooks/manifest.json` 每个 entry 已加 `tier` 字段，`docs/rules/05-harness.md` 已记录分类法：

| tier | 语义 |
|---|---|
| `core` | 任何项目都跑 |
| `fpga` | 仅 `.sv/.v` 写入时唤醒 |
| `codegraph` | 图索引 |
| `office` | 文档域 |
| `lab` | 实验性，不得 `active: true` |

当前标注：core ×10、codegraph ×1（codegraph-sync）、lab ×1（loop-controller）。fail-closed 白名单只有 `bash-safety` 与 `file-protection`，其余门禁 fail-open 降级为 advisory。

### 2.3 目录迁移映射（2026-09-08 全图盘点结果）

| 迁入 | 现位置 | 备注 |
|---|---|---|
| **packs/fpga/skills/** | `skills/{vivado-flow, rtl-gen, hdl-coding, python-hardware-debug}` | 4 个 FPGA 域技能 |
| **packs/fpga/agents/** | `agents/domain/`（logic-engineer、algorithm-engineer）+ `agents/compound/`（ce-* 评审团 4 个） | 不新建 `fpga-algorithm-engineer`，现有专家即等价物 |
| **packs/fpga/scripts/**（或经 skills 引用驻留 engine） | `engine/scripts/{fpga-timing-parser, fpga-xdc-parser}.cjs`、`lib/module-topology.cjs` | DAG 可视化复用 `code-graph-index`/`cg-queries` 加渲染层，不另起炉灶 |
| **packs/fpga/references/** | ~~`engineering-assets/reference-assets/`~~ **已迁**（2026-09-08，2875 文件：vendor/ 6 个第三方上游工程 + datasheets/） | 消费方 3 处（kb-stats / perf-monitor / add_name_frontmatter）已同步改指新路径；`knowledge/`、`catalog/`、`cbb/` 等留 Core（engine 经 config.path.sh 消费） |
| **packs/office/skills/** | `skills/{doc-gen, markitdown-converter, pdf, presentation}` | 4 个文档域技能 |
| **Core 保留** | `engine/` 全部、hooks、diagnostics、`schemas/`、`docs/rules/`、通用技能（code-review、debugging、git-expert、tdd…） | 通用域不迁移 |

规划中的新增（对照 `Desktop/fpga_harness_plan.md` v0.1 的裁决）：

| 候选 | 裁决 | 说明 |
|---|---|---|
| `xdc-constraint-gen` | **做**，packs/fpga 首个新技能 | 唯一真实缺口：现有 `fpga-xdc-parser.cjs` 只解析不生成；从解析器反推三套模板（clock-period / pin-assignment / timing-exception） |
| vivado-report-parser | **不做** | `fpga-timing-parser.cjs` 已覆盖 WNS/TNS/Fmax，避免重复实现 |
| `fpga-algorithm-engineer` 新专家 | **不做** | 与 domain/compound 现有专家重复 |
| bin/ 工具目录 | **不做** | engine/scripts + skills/*/scripts 已覆盖 |
| PSS 检测 / 频偏估计 MATLAB | 归 packs/fpga 项目资产 | 按需创建，不预建 |

### 2.4 迁移步骤（M4b 目录重构，已于 2026-09-08 执行，见 §2.5）

1. 前置：在途变更（§1.2 表中工作树项）全部提交、`run-all-tests` 全绿、`render-hook-settings --check` 0 漂移。
2. 建 `packs/fpga/`、`packs/office/` 骨架，`git mv` 迁移 §2.3 表中条目（保留历史）。
3. 更新引用方：manifest tier 标注与 pack 归属对齐；`.claude-plugin/` 清单、`plugins.lock.json`、skills 互引路径。
4. 市场渠道脚本改为仅复制 per-plugin 目录（Core 不出仓）。
5. 验收：`run-all-tests` 全绿；`render-hook-settings --check` 0 漂移；`plugin-manifest-contract` 通过；`manifest` 交叉核对 0 error；干净 worktree（剥离 gitignore 产物 + 本机工具链）在 Windows 与 CI matrix 各 OS 上 exit 0。

### 2.5 M4b 实施记录（2026-09-08 同日执行）

- **已迁**：fpga 4 技能 + office 4 技能（git mv 保历史）→ `packs/{fpga,office}/skills/`；`agents/{domain,compound}` → `packs/fpga/agents/`。
- **运行时发现镜像**：新增 `engine/scripts/sync-pack-skills.cjs`（对齐 sync-workflow-mirror 契约：packs 权威源单向复制到 `skills/`、`--check` 漂移检查）；镜像路径在 `.gitignore` **锚定仓库根**忽略（未锚定会任意深度匹配、静默吞掉 packs 下权威源新文件）。
- **引用更新**：engine/rtl-bench、check-templates、run-all-tests、eval prompt、hdl-coding-dag-workflow、docs/rules/01-hdl·02-python、skills/workflows/hdl-coding-workflow.md 的路径引用改为 packs 权威源；**pack 内部技能互引保留 `skills/<name>/` 相对形式**（对镜像与插件安装两种场景都可解析）。
- **engine 的 fpga 脚本驻留 Core**（§2.3 的备选分支）：`fpga-timing-parser`/`fpga-xdc-parser`/`module-topology` 未迁移——引擎与测试按仓库内路径引用，迁移收益低、破坏面大。
- **per-plugin 分发**：`packs/{fpga,office}/.claude-plugin/plugin.json` 使各 pack 成为可独立安装的 Claude Code 插件（skills 自动发现于 pack 根）。
- **xdc-constraint-gen 落地**：SKILL.md + 3 个语法基准模板 + `gen_xdc_from_rtl.py`（stdlib-only；ANSI/非 ANSI 端口解析、时钟与复位启发式、参数化位宽显式警告不静默丢端口；冒烟测试含边界用例，错误路径 exit 2）。已注册进 OWNED 镜像清单。
- **市场渠道脚本**：scripts/ 下无既有打包脚本，per-plugin 复制由 pack 自带清单承接；未来建渠道脚本时按"仅复制 pack 目录"原则实现。

---

## 3. 2026-09-08 执行记录

| 项 | 结果 |
|---|---|
| M1 收尾复核 | **非测试代码已闭环**。此前记档的 4 处"var/ 硬编码残留"逐处核实为误报：两 guard 的 `projectRoot/var/gates` 是项目级候选路径（eval 流写入目标，M1 有意保留）；`bench-hooks.cjs:39` 是 tmpdir 基准沙箱；`ctx-checkpoint.sh` 的 env+legacy 两级回落是 `engine/config.path.sh:10-11` 明文记载的 shell 侧既定设计 |
| hook 注册漂移 | **发现并修复**：本机 `settings.json` 盘符大小写（`C:/` vs `c:/`）导致 8 事件全判漂移，按模板权威源重渲染后 `--check` 0 漂移（settings.json / workbuddy.hooks.json / plugin.hooks.json 三产物一致） |
| 契约验证 | hook-latency-sla 9/9、gate-load-degradation 7/7、guard-coverage 12/12（51 cases） |

## 4. 未决问题（阻塞项按序）

1. ~~在途变更归属与提交~~ **已解决（2026-09-08）**：用户裁决"验证后统一提交"，M4a 在途工作经 474/474 全量回归验证后以 `dbed370` 提交。
2. ~~push 冲突~~ **已解决（2026-09-08）**：用户裁决"必须 push"，分支已推 origin。提交过程中 safe-delete 第八次实时复发（loose ref 亚秒级被删），按恢复手册直写 packed-refs 后恢复并推送成功。
3. ~~reference-assets 归属~~ **已解决（2026-09-08）**：2875 文件全部 `git mv` 至 `packs/fpga/references/`（vendor/ 零程序化消费 + datasheets/ 仅 3 处消费方，均已改引用）。Core 的 `engineering-assets/` 保留 catalog / knowledge（engine 经 config.path.sh 消费）/ cbb / models / evidence / schemas。仓库入库文件结构：fpga 域资产（skills + agents + references）自此集中于 packs/fpga。
4. ~~`agents-archive/`、`rules-archive/` 盘点~~ **已解决（2026-09-08）**：两者均留在 Core，无需迁移。`docs/rules-archive/`（11 份低频规则）是 Core 活依赖——gate-registry-contract.cjs:123 断言其存在、workflow-contracts.cjs:360 直接读内容、fix-in-place-guard 与 file-protection-guard 指向其文档；`docs/agents-archive/`（2026-07-27 PI 审查归档的上游导入残留，17 个未注册角色）无活代码引用，仅作角色提示词写法参考资料，属 harness 通用文档，不具 pack 归属特征。
5. ~~**safe-delete 删除者身份**~~ **已查明（2026-09-08 排查，推翻原 codex 归因）**：删除者是 **WorkBuddy 宿主自身的沙箱 safe-delete 体系**，与 codex.exe 无关。证据链：(a) `~/.workbuddy/logs/` 会话与沙箱日志中直接出现 `[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":3570,"threshold":50,"scope":"turn",...}`（scope=turn 证明按 turn 计数）；(b) 沙箱为每个 Bash 子进程注入 `BASH_ENV=shell-runtime-bash-env.sh` + `PATH 首位 safe-bin`（rm/unlink/rmdir shim）+ `NODE_OPTIONS=--require node-language-shim.cjs` + `CODEBUDDY_SAFE_DELETE_*` 全套 env，资源全部位于 `D:\wrokbuddy\WorkBuddy\resources\app.asar.unpacked\cli\vendor\shim\`；(c) 沙箱是**写拦截型**（LiteSandbox/tsbx broker，modify_backup.enabled=true）——第八次事故 17:45:21 commit 进程的每次 `.git` 写入（index.lock、tmp_obj_*、ref lock）均被 broker `ModifyBackup reason:"a"` 拦截备份（内容寻址落 `~/.workbuddy/file-history/<session>/`）；(d) GC 日志在事故窗口无活动，排除 GC。**时点修正**：探针实验证明 loose ref 同 turn 内跨命令存活（3s+），19:59 escalated 提交的 loose ref 亦在 ~10 分钟内消失——删除发生在异步/turn 边界而非亚秒级即时，"escalated 不中招"是观察窗口过短的误判。遗留验证：探针 ref `sb-probe` + `probe-file` 留存于 .git/refs/heads/，下个 turn 检查存活即可定论 turn 边界假说（验证后清理）。
