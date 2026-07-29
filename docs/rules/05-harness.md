---
name: harness-memory-rules
description: "Harness memory, Dream, hook telemetry, maintenance, retrieval, and durable rule governance."
priority: L1
trigger: "memory,记忆,dream,Dream,hook,harness,maintenance,维护,semantic,语义索引,watermark,候选规则,settings.json,注册,registrations,CI,门禁,镜像"
skip: ""
---

# Harness 与记忆层规则

## Scope

本规则只约束 Harness 自身的运行事件、记忆事实、Dream 输出、语义索引、定期维护和规则晋升。它不替代领域知识库、项目状态交接或代码验证规则。

以下任务必须加载本规则：

- 修改 Hook 事件语义、Dream、SQLite 记忆表、检索、健康检查或维护脚本；
- 新增、删除、改名或改变触发条件的 Hook，以及改动 `settings.json`、`engine/hooks/manifest.json`、CI workflow；
- 根据历史错误新增全局约束；
- 声称记忆“健康、已学习、可召回、已清理、已晋升”为规则；
- 声称门禁“已通过”“已生效”，而验证只在本机跑过；
- 排查重复失败，但此前经验没有被召回或已经过时。

## Trigger conditions

| 条件 | 必须动作 | 不允许的捷径 |
|:-----|:---------|:-------------|
| 新任务涉及已知仓库、模块、Hook 或历史决策 | 先按主题、路径、错误签名检索；只读取最相关条目 | 全量注入记忆目录 |
| 同一错误第二次出现，或同一修法无进展两次 | 固定真实输入，查询相同错误签名与触发条件 | 继续累积原始失败日志 |
| 检索前发现 meta 缺失、文件新增、mtime 变化或索引过期 | 返回 `stale_index`，先重建索引 | 用旧向量给出“可能相关”结果 |
| 定期维护到期 | 先运行 `dry-run` 检查计划，再显式 execute | 在 dry-run 写 DB、账本、索引或状态 |
| 错误记录包含根因、已验证修复、预防动作和精确触发条件 | 仅进入规则候选账本 | 直接写核心规则 |
| Dream 发现统计模式 | 仅产生待验证候选 | 自动修改规则或把相关性当因果性 |

Agent 只有在任务主题、路径、错误签名或用户明确要求与候选条目的 trigger conditions 匹配时才召回该经验。泛化主题相似但触发条件不匹配时，不注入正文。

## Stable rules

### 1. 真实事件语义优先

`PostToolUse` 或 `PostToolUseFailure` payload 缺少 `status` 字段，既不等于成功，也不等于失败。判定必须来自真实事件类型、工具结果与显式 PASS/FAIL 证据；测试必须覆盖生产 payload 形状。

### 2. 健康度测功能闭环，不测文件存在

记忆健康报告至少同时检查：未消费事件与 watermark、Dream 输出、session 标识质量、Markdown/SQLite 漂移、噪声比例、语义索引 freshness、维护是否到期及是否有调度。任一关键链路失效时必须降低评分并返回不健康，禁止“结构齐全即 100 分”。

### 3. 每个消费者使用独立 checkpoint

事件消费进度必须采用 consumer-specific watermark。Dream、技能演化、统计或清理任务不得共享或覆盖同一个全局 checkpoint；dry-run 不得推进任何 watermark。`purgeConsumedEvents` 只能按所有已注册消费者的最小 watermark 删除超过 retention 的事件。

迁移注册的消费者必须同时具有真实、有界、可观测的调度。注册消费者未调度或严重落后时，健康检查必须失败，retention 保持阻塞；不得把它临时标记 dormant、从 MIN 中筛掉或强推水位。若消费者永久退役，须以显式迁移删除注册项，并附无未消费依赖的证据。

### 4. dry-run 严格只读

`memory-knowledge-maintenance.cjs` 的 `dry-run` 只能计算 due 状态、保留计划、对账差异、候选与重建需求。只有显式 execute 才可依次执行受控事件保留、事实对账、候选 staging、索引重建和维护状态写入；不移动原始记录来伪装提炼。

### 5. 检索对陈旧索引失败关闭

语义索引的可信条件是：index 与 meta 均存在，eligible 文件集合一致，记录的 mtime 一致，并且 builtAt 未超过 freshness 窗口。否则查询返回 `stale_index` 和空结果，`kb-stats --check --quiet` 仍须非零退出；quiet 只抑制人类文本，不能改变检查结论。

### 6. 遥测不等于经验

`tool_success`、单次 `tool_error`、Hook 触发记录和 singleton session 是运行遥测，不是长期记忆。只有能回答“何时触发、为何发生、如何修复、用什么证据验证、何时失效”的条目才有资格成为候选经验。

### 7. Hook 注册的权威源是入库模板，不是 `settings.json`

`settings.json` 是**渲染产物**，在 `.gitignore` 里。它必须含本机绝对路径——hook 命令改用 `$HOME` 会导致静默不触发，既不报错也不执行，是本仓库代价最高的一类失败。

因此注册的唯一权威声明是 `engine/hooks/registrations.json`，用 `{{HARNESS_ROOT}}` 占位保持可移植。

| 动作 | 必须 | 不允许 |
|:-----|:-----|:-------|
| 新增/修改/删除 Hook | 改模板，再跑渲染器生成 `settings.json` | 直接编辑 `settings.json`（会被 `--check` 判为漂移） |
| 模板写路径 | `{{HARNESS_ROOT}}/...` 占位 | 本机绝对路径；`$HOME`/`~` 等 shell 展开 |
| 同一个 Hook | 只在一处注册 | 同时写进 `settings.json` 与 `settings.local.json`（会每次触发跑两遍） |
| 新增 Hook 落地 | 同时在 `engine/hooks/manifest.json` 声明，且 `active` 与真实注册一致 | 只注册不声明，或声明 `active: true` 却没有注册 |
| `.claude/workflows/` 镜像 | 由 `sync-workflow-mirror.cjs` 从 `workflows/` 单向重建 | 反向同步（会把手工改镜像的错误“修”掉，那正是漂移检查要抓的） |

`manifest.json` 与实际注册的交叉核对是硬门禁。它读不到任何注册来源时**必须报错**，不得因“环境里没有 settings.json”而跳过——那正是它唯一有意义的场景。

### 8. 门禁断言不得依赖未入库路径；依赖了就显式跳过

断言的对象若位于 `.gitignore` 覆盖的路径（`settings.json`、`var/`、`.claude/`、`plugins/`），它检的是**操作员本机状态**，不是仓库契约，在干净环境里永远不可能成立。

处理方式只有一种：按环境条件**显式跳过并打印原因**，并登记进 `engine/scripts/test-hooks/skip-manifest.json` 的白名单（`maxSkips` 同步上调）。

- 不允许删断言——本机的检查价值仍在；
- 不允许让它无声通过——那样“检过了”和“没检”就分不开了；
- 不允许为了让 CI 变绿而放宽门禁本身的判定条件。

一条断言若同时含仓库契约与本机状态两部分，只跳过本机那部分，契约部分在任何环境都继续强制执行。

### 9. 本机绿不是 CI 绿的证据

本机带着全部 `.gitignore` 产物（`settings.json`、`.claude/`、`var/`），干净 checkout 一个都没有。“本机 CI 通过”对 GitHub 结果没有推断力。

改动 Hook 注册、CI workflow、门禁判定或任何读取上述路径的检查后，验证必须在**不含 gitignore 产物的干净工作树**里复跑：

```bash
git -c core.longpaths=true worktree add --detach <短路径> HEAD   # Windows 上路径要短，否则 MAX_PATH 会截断 checkout
```

先在干净树里**复现失败**，再验证修复；两个环境的通过/跳过数差异必须能逐条解释。解释不了的差异说明跳过是无条件的，不是环境条件触发的。

## Rule promotion lifecycle

唯一允许的生命周期是：

`candidate -> verified -> approved -> promoted`

1. `candidate`：维护或 Dream 只提交结构化候选，记录来源，不改变规则。
2. `verified`：必须具备根因、已验证修复、预防动作、触发条件，以及真实行为测试或回归的 PASS 证据。
3. `approved`：必须由用户或明确授权的维护者显式批准；沉默、自动任务和模型自评不算批准。
4. `promoted`：通过 `harness-rule-candidates.cjs` 幂等写入本文件或后续专用规则文件，并保留 candidate id、证据边界和批准者。

Dream output MUST NOT auto-promote a candidate into a durable rule; explicit approval is always required.

候选字段不完整、只有静态检查、只有日志数量、只有模型解释或失败仍未复现时，保持 `candidate`，到期后退役，不得补写为“已验证”。

## Evidence boundaries

| 可声称结论 | 最低证据 | 不能外推 |
|:-----------|:---------|:---------|
| dry-run 只读 | 注入写接口计数为 0 的行为测试 | 仅查看 `--dry-run` 参数名 |
| execute 受控 | 受控接口的调用顺序与结果断言 | 原始文件被移动或数量减少 |
| 索引新鲜 | eligible/path/mtime/builtAt 全部匹配 | 仅 meta 文件存在或 fileCount 相等 |
| 经验已验证 | 真实输入 RED→修复→GREEN 或等价回归证据 | 静态审查、Dream 相关性、模型自报 |
| 规则已生效 | 规则文件已晋升且对应触发/阻断测试通过 | 候选已生成或被读取过 |
| 记忆健康 | 健康报告全部关键链路达标 | 文件数量少、SQLite 能打开 |
| Hook 已注册并生效 | 模板渲染后 `--check` 无漂移，`manifest` 交叉核对 0 error，且真实触发过一次 | `settings.json` 里有这一行、JSON 语法正确 |
| CI 会通过 | 干净 worktree 里 `harness-ci.cjs` exit 0，且与本机的通过/跳过差异可逐条解释 | 本机 exit 0 |

结论必须区分“已观察”“推断”“未实时验证”。代码或事件契约变化后，相关 promoted 规则回到待复核状态；旧证据不能自动覆盖新 payload。

## Operations

```powershell
# 只读维护计划
node engine/scripts/memory-knowledge-maintenance.cjs --dry-run --json

# 机器可读健康与索引检查
node engine/scripts/memory-health-check.cjs --json
node engine/scripts/kb-stats.cjs --check --quiet --json

# 索引失效后显式重建
node engine/scripts/semantic-search.cjs index --rebuild

# 查看候选
node engine/scripts/harness-rule-candidates.cjs list
```

Hook 注册的重建与校验（换机、新克隆、CI，以及每次改完 Hook）：

```powershell
# 改 engine/hooks/registrations.json 之后渲染出本机 settings.json
# 只替换 hooks 字段，env/model/statusLine/theme 等本机配置原样保留
node engine/scripts/render-hook-settings.cjs

# 校验本机注册是否与模板漂移；CI 与提交前都要跑
node engine/scripts/render-hook-settings.cjs --check

# 同理从 workflows/ 单向重建 .claude/workflows/ 镜像
node engine/scripts/sync-workflow-mirror.cjs
node engine/scripts/sync-workflow-mirror.cjs --check
```

事件消费者的调度合同：Dream 与 Skill-Evolve 都必须有真实、有界、可观测的执行路径。当前 Dream 由 Session bootstrap 触发，Skill-Evolve 由异步 Stop observer 在同一进程调用，默认每次最多 harvest 100 条且只 stage 提案。每个消费者必须在 `engine/hooks/manifest.json` 的 `consumerRegistry` 中声明事件、宿主入口、批量/时效阈值和 heartbeat/watermark 要求；宿主 entry 必须显式链接 consumer，且该宿主必须真实注册在 `settings.json`。health 只依据这份结构化注册表、实际 Hook 注册和 SQLite heartbeat 判定 `scheduled`、`never-run`、`stale`、`failing`，不扫描源码文本猜测依赖；只在 migration 中插入 watermark 行不算已启用。health 还必须报告 exposure/application/outcome 计数与身份链完整性，以及 candidate 各状态数量、字段完整性和 30/90 天审查期限；没有 outcome 本身不是失败，孤儿身份链与逾期未审才是问题。

Markdown 对账是权威快照：源文件删除 `project_id`、`path_scope` 或 `trigger_signature` 时，SQLite 旧值必须被清除。普通 Hook 的局部 upsert 仍保留未提供字段。`trigger_signature` 只在调用 Hook 能从真实 payload 稳定复现该签名时使用，不得为自然语言查询凭空填写不可达签名。

规则晋升的四步 CLI 合同如下；每一步独立落账，不允许合并或跳级：

```powershell
# candidate.json: title/source/rootCause/verifiedFix/prevention/triggerConditions
node engine/scripts/harness-rule-candidates.cjs stage --input candidate.json --ledger var/maintenance/harness-rule-candidates.json --by memory-maintenance

# verification.json: evidence 数组；至少一项 behavioral_test/regression，并含同一行为契约的账本化 RED/GREEN
# red/green 均需 command、真实 exitCode、verification-gate ledger 路径与 entrySha256；contractHash 必须相同
node engine/scripts/harness-rule-candidates.cjs verify --id hrc-<id> --input verification.json --ledger var/maintenance/harness-rule-candidates.json --by verifier

# 人工批准必须带 --explicit；没有此标志即失败
node engine/scripts/harness-rule-candidates.cjs approve --id hrc-<id> --ledger var/maintenance/harness-rule-candidates.json --by user --explicit

# 只有 approved 候选可写入规则；--by 必须在任何文件写入前通过校验
node engine/scripts/harness-rule-candidates.cjs promote --id hrc-<id> --ledger var/maintenance/harness-rule-candidates.json --rules docs/rules --by maintainer
```

Agent 只有在同一真实命令与同一 `contractHash` 上先失败、修复后通过，取得 `real RED -> GREEN`，且 RED/GREEN 都已由 Verification Gate 写入证据账本时，才可调用 `verify --id`。验证器会重新计算账本 entry SHA-256，核对命令、stdout/stderr 哈希、真实退出码、Gate 接受状态与时间顺序；任一不一致即拒绝。模型自报 PASS、静态审查结论、Dream 置信度、任意 JSON 或无法复现的旧日志都不能写成 `result: "PASS"`。

晋升会原子写入独立的 `docs/rules/90-promoted-hrc-*.md`，其 frontmatter 必须带可索引的 `trigger` 与 candidate id；新会话由 rule loader 按 trigger 命中后注入。加载和硬门禁执行前都必须回查候选账本中的 explicit approval、账本化验证、文件名/marker/frontmatter candidate id 与晋升时记录的 artifact SHA-256；手工复制、缺账本或被篡改的文件保持不生效，并由健康检查报告。默认 `enforcement: advisory` 只注入规则正文。只有显式批准且声明 `enforcement: block` 的候选可生成硬门禁；硬门禁仅允许 `command`/`file_path` 上的 `contains`、`equals`、`prefix` 声明式谓词，不执行候选提供的代码或正则表达式。

任何清理先保留可追踪的 candidate id、验证证据和批准记录。不要以减少文件数代替提炼，也不要用删除维护状态或强推 watermark 来制造健康状态。
