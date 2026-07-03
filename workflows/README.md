# 工作流目录

> Workflow 名称解析目录。所有 `.js` 文件可通过 `Workflow({name: '<文件名>'})` 调用。

## 可用工作流

| 文件名 | 调用名 | 用途 | 状态 |
|:-------|:-------|:-----|:-----|
| `hdl-coding-dag-workflow.js` | `hdl-coding-dag-workflow` | HDL RTL 开发 DAG 工作流 v3.4（主入口） | ✅ 可执行 |
| `hdl-coding-workflow.js` | `hdl-coding-workflow` | 别名，代理到 dag 版本（向后兼容） | ✅ 可执行 |
| `code-review-workflow.js` | `code-review-workflow` | 两轮代码审查（Pass 1 正确性 + Pass 2 代码质量） | ✅ 可执行 |
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

## Lite 模式

```js
Workflow({name: 'hdl-coding-dag-workflow', args: {modules: ['fir'], lite: true}})
```

## 添加新工作流

1. 在本目录创建 `.js` 文件，文件名为 `{workflow-name}.js`
2. 文件必须包含 `export const meta = { name, description, phases, contract }`
3. 通过 `Workflow({name: 'workflow-name', args: {...}})` 调用
4. 严格工作流必须声明 `contract.strict=true`、输入、检查点、证据来源和完成标准。
5. 不允许在 workflow 文件中使用 CommonJS `require()`、`execSync`、`spawnSync` 或直接 shell 执行；确定性证据扫描应通过 `engine/scripts/workflow-evidence-scan.cjs` 等外部证据脚本完成。

## 回归验证

```bash
node engine/scripts/test-hooks/workflow-contracts.cjs
node engine/scripts/workflow-evidence-scan.cjs --json --targets workflows/security-review-workflow.js
node engine/scripts/test-hooks/run-all-tests.cjs
```

## 参考文档

详情文档在 `skills/workflows/` 下：
- `skills/workflows/hdl-coding-workflow.md` — HDL 流程定义文档
- `skills/workflows/hdl-coding/` — 各 Phase 详细说明
- `skills/workflows/code-review/` — 审查标准文档
- `skills/workflows/architecture-review/` — 架构审查标准
