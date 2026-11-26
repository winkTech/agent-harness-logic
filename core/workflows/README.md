# 工作流目录

> Workflow 名称解析目录。所有 `.js` 文件可通过 `Workflow({name: '<文件名>'})` 调用。

## 可用工作流

| 文件名 | 调用名 | 用途 | 状态 |
|:-------|:-------|:-----|:-----|
| `hdl-coding-dag-workflow.js` | `hdl-coding-dag-workflow` | HDL RTL 开发、仿真和阶段签收（主入口） | ✅ 可执行 |
| `hdl-coding-workflow.js` | `hdl-coding-workflow` | 别名，代理到 dag 版本（向后兼容） | ✅ 可执行 |
| `code-review-workflow.js` | `code-review-workflow` | 两轮代码审查（Pass 1 正确性 + Pass 2 代码质量） | ✅ 可执行 |
| `blind-audit-workflow.js` | `blind-audit-workflow` | 双盲独立审计（先加封预期→隔离四象限探针→分级报告） | ✅ 可执行 |
| `architecture-review-workflow.js` | `architecture-review-workflow` | 四维架构审查（上下文→架构分析∥安全→建议） | ✅ 可执行 |
| `security-review-workflow.js` | `security-review-workflow` | 安全审查（威胁建模→扫描→验证→修复） | ✅ 可执行 |
| `rag-skill-workflow.js` | `rag-skill-workflow` | 知识库检索（必须带 query 和 file:line 引用） | ✅ 可执行 |

## 使用示例

```js
Workflow({name: 'hdl-coding-dag-workflow', args: {modules: ['scrambler']}})
Workflow({name: 'code-review-workflow', args: {files: ['01_src/tx/scrambler.sv']}})
Workflow({name: 'architecture-review-workflow', args: {targets: ['01_src/tx/ofdm_tx.sv']}})
Workflow({name: 'security-review-workflow', args: {targets: ['src/']}})
Workflow({name: 'rag-skill-workflow', args: {query: '复位命名规则'}})
```

## 检查点续跑 (hdl-coding-dag-workflow v3.6)

工作流在 preflight / design-review / evidence-review 检查点暂停
（抛 `[WorkflowCheckpoint:<name>]`）。用户审查产出后带确认参数续跑。原生宿主按自身回执规则处理 `resumeFromRunId`。

```js
// 首跑 → 停在 preflight
Workflow({name: 'hdl-coding-dag-workflow', args: {modules: ['fir']}})
// 确认 preflight → 停在 design-review
Workflow({scriptPath, resumeFromRunId, args: {modules: ['fir'], confirmed: true}})
// 逐点确认继续
Workflow({scriptPath, resumeFromRunId, args: {modules: ['fir'], confirmed: true,
  checkpoints: {'design-review': {confirmed: true}}}})
// 无人值守 (显式跳过全部用户检查点)
Workflow({name: 'hdl-coding-dag-workflow', args: {modules: ['fir'], confirmAllCheckpoints: true}})
```

证据判定由 `core/engine/scripts/hdl-evidence-gate.cjs` 完成。它读取工程产物并输出 JSON 和 `RESULT: PASS/FAIL`。支持本地动作的宿主直接运行门禁。

## HDL 长任务与外部工具

> **生效范围说明**：直接通过宿主内置 `Workflow` 工具运行 `hdl-coding-dag-workflow` 时，默认生效结构化交接压缩与 `hdl-evidence-gate.cjs` 确定性证据/新鲜度校验；本地工具去重执行（`profiles`）、跨轮增量历史省略（`contextHistory`）和检查点产物重用（`agentReceipts`）需由宿主注入 `createHdlWorkflowBindings` 或通过 `run-hdl-workflow.cjs --host` 显式配置。

支持注入工作流能力的宿主可调用 `createHdlWorkflowBindings`，向同一份 DAG 提供 `workflowAction` 和 `workflowContext`。有工程模型回调的宿主也可直接调用 `runHdlWorkflow`，或者从插件根运行：

```powershell
node core/engine/scripts/run-hdl-workflow.cjs --host D:/approved/hdl-host.cjs --args D:/projects/fir/workflow.json --project D:/projects/fir --state-dir D:/workflow-state/fir --run-id fir-01 --signoff-id fir-accept-01 [--recover]
```

`--args` 接受原工作流参数，如 `{"modules":["fir"]}`。退出码 2 表示等待用户审查，0 表示此次请求的范围完成，1 表示错误。获得相应确认后更新参数，沿用相同运行和签收 ID 接回已有作业；若前次后台作业异常中断为 `lost`、`cancelled` 或 `timed_out`，追加 `--recover` 可在原运行 ID 下安全归档旧记录并重投，或保持相同 `--signoff-id` 更换 `--run-id` 以保留已验收的阶段产物回执。开启新一轮全量签收时更换 `--signoff-id`。状态目录位于工程之外，只授予运行账户访问。宿主提供某类工具动作时，工作流直接调用，执行错误会传回流程。宿主未提供该类能力时沿用原有模型派发路径。工程参数只描述任务，工具配置由宿主管理。

由宿主管理员配置 `--host` 所指的可信模块。以下是一个仿真 profile 示例，模型回调接入已有宿主，文件名应换成该工程真实文件。

```js
module.exports = {
  agent: require('./engineering-host.cjs').agent,
  profiles: {
    simulate: {
      fir: {
        executable: process.execPath,
        args: ['tools/run-fir-sim.cjs'],
        inputs: ['tools/run-fir-sim.cjs', 'rtl/fir.sv', 'sim/tb_fir.sv', 'sim/vectors.hex'],
        top: 'tb_fir',
        version: 'fir-sim-v1',
        tools: [{executable: 'D:/eda/bin/iverilog.exe', versionArgs: ['-V'], expectedVersion: 'Icarus Verilog'}],
        minComparedPoints: 256,
        timeoutMs: 120000
      }
    }
  }
};
```

工具以工程根为工作目录，用固定可执行文件和独立参数启动。包装脚本在本次环境变量 `HARNESS_WORKFLOW_EVIDENCE` 指定的位置写结构化结果。仿真回执至少包含 `module`、`status`、`compared_points` 和 `mismatches`。功能失败应记录首个差异并以非零码退出。宿主会自动递归哈希工程内静态 `` `include `` 与本地 Python 模块依赖，动态加载输入仍须列入 `inputs` 清单。全量回归配置必测工况，布局布线配置器件、顶层、XDC 和目标阶段，签收同时检查建立、保持、各阶段（含 `opt`/`place`）零错误及本次运行新鲜生成的 `route_status.rpt`（位于私有 `runDir` 或工程内 `report_dir`）。

确定性程序持有长作业，等待终态时无需模型轮询。每轮修复只携带本次偏差、已尝试假设和证据位置。交接、修复、裁决包的软预算分别为 1k、4k、8k 估算 token，签收约束、授权范围和证据引用保留。工具不可用或证据不足会给出具体原因。同一失败假设两次未能解决问题会停止该轮修复并请求决策。

模型回调为 `agent(prompt, options, context)`。通过 `context.recordResponse({callId, usage, evidenceReads})` 为每个真实响应回报互斥的 `uncachedInputTokens`、`cachedInputTokens`、`outputTokens`。可选的 `evidenceReads` 记录该响应额外读取证据的次数。运行报告给出事件和计量文件路径。宿主缺少计数时保留未知。派发事件记录上下文预算、估算值，以及必要字段超额时的实际扩容量。P0–P3 产物生成（含 `p3-selftest`）与 P4 初始模块编码（`rtl-code-<mod>`）可通过 `agentReceipts[label] = {version, inputs, outputs, verify}` 显式允许跨检查点重用；每次重用前重新校验输入、输出及宿主验收函数。后续独立审查、对抗抽检与签收始终重新执行。

支持持续会话的宿主可导出同步函数 `contextHistory(options, context)`，返回 `{threadId, epoch, historyAvailable: true}`。宿主按 `context.history` 派送，压缩历史或切换用户时更换 epoch。同一模块的实现和修复带相同 `affinityKey`。只有同一接收者已成功收到的相同摘要才会省略。摘要中的验收字段应沿用原始报告的名称、层级与单位，使完整报告和摘要能使用同一套判据。

## Lite 模式

```js
Workflow({name: 'hdl-coding-dag-workflow', args: {modules: ['fir'], lite: true}})
```

## 添加新工作流

1. 在本目录创建 `.js` 文件，文件名为 `{workflow-name}.js`
2. 文件必须包含 `export const meta = { name, description, phases, contract }`
3. 通过 `Workflow({name: 'workflow-name', args: {...}})` 调用
4. 严格工作流必须声明 `contract.strict=true`、输入、检查点、证据来源和完成标准。
5. 不允许在 workflow 文件中使用 CommonJS `require()`、`execSync`、`spawnSync` 或直接 shell 执行；确定性证据扫描应通过 `core/engine/scripts/workflow-evidence-scan.cjs` 等外部证据脚本完成。

## 回归验证

```bash
node core/engine/scripts/test-hooks/workflow-contracts.cjs
node core/engine/scripts/workflow-evidence-scan.cjs --json --targets workflows/security-review-workflow.js
node core/engine/scripts/test-hooks/run-all-tests.cjs
```

## 参考文档

详情文档在 `skills/workflows/` 下：
- `skills/workflows/hdl-coding-workflow.md` — HDL 流程定义文档
- `skills/workflows/hdl-coding/` — 各 Phase 详细说明
- `skills/workflows/code-review/` — 审查标准文档
- `skills/workflows/architecture-review/` — 架构审查标准
