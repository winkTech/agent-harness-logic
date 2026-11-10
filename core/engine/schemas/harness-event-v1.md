# Harness Event v1 —— 归一化内部事件契约

`harness-event-v1` 是 harness 与各执行工具（Claude Code / WorkBuddy / Codex）之间的**内部事件契约**。
所有 hook 只消费本契约形状的事件对象，不直接解析各工具的原始 payload。

- Schema: `engine/schemas/harness-event-v1.schema.json`
- 生产归一化的代码: `engine/scripts/transport/<transport>.cjs`（每工具一个适配器）
- 注册/消费声明: `engine/hooks/manifest.json` 的 `payloadSchema: "harness-event-v1"` + `transport` 字段

## 设计原则（不可破坏）

1. **D1 真实事件语义**：`status` 三值 `succeeded | failed | unknown`。
   原始载荷**缺 status 时 transport 一律归一化为 `unknown`**，绝不臆测成功/失败。
   - `PostToolUseFailure` 事件名本身是失败证据 → `failed`（事件名算证据，不算臆测）。
   - Claude `PostToolUse` 通常无 status → `unknown`，由 hook 层（如 progress-watchdog）按输出证据细化。
2. **eventType 是中性事件名**：`tool.pre` / `tool.post` 等不含结果语义；结果只由 `status` 承载。
   这保证"PostToolUse 并不等于成功"的语义不会在契约层丢失。
3. **fail-closed**：非法 JSON / 无法识别的载荷 → 归一化失败必须显式失败（transport 抛错或产出 `unknown` 事件），绝不静默吞掉。

## 字段表

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `schema` | string | ✓ | 固定 `harness.event` |
| `version` | number | ✓ | 固定 `1` |
| `eventId` | string | ✓ | transport 生成的唯一 ID（uuid 或确定性派生），去重/审计用 |
| `eventType` | enum | ✓ | 中性事件类型，见映射表 |
| `transport` | enum | ✓ | `claude-code` \| `workbuddy` \| `codex` |
| `occurredAt` | ISO | ✓ | 事件发生时间；缺失时取 `receivedAt` 并标记 `source.timestampInferred` |
| `receivedAt` | ISO | ✗ | transport 接收时间（接收侧时钟） |
| `sessionId` | string | ✓ | 归一化会话标识，transport 内稳定（watermark/去重/状态隔离） |
| `cwd` | string | ✓ | 事件时工作目录（绝对路径），门禁/项目作用域判定用 |
| `status` | enum | ✓ | `succeeded` \| `failed` \| `unknown`（D1） |
| `toolName` | string\|null | ✗ | 工具事件：工具名 |
| `toolInput` | object\|null | ✗ | 工具事件：输入参数（**含敏感内容，hook 不得写日志**） |
| `toolUseId` | string\|null | ✗ | 工具事件：工具调用 ID |
| `actor` | object\|null | ✗ | 发起者（Claude/WorkBuddy 载荷无此概念时为 null） |
| `source` | object | ✗ | 溯源：`nativeEventName` / `adapter` / `statusInferred` / `timestampInferred` / `payloadHash` |
| `raw` | object\|null | ✗ | 原始 payload 保留（默认 null；按需附带，hook 负保密责任） |
| `extensions` | object | ✗ | 扩展点（不承载契约级语义） |

## eventType 映射表

| 工具事件名 | 归一化 eventType | 说明 |
|---|---|---|
| `SessionStart` | `session.start` | 会话开始 |
| `UserPromptSubmit` | `prompt.submit` | 用户提示提交 |
| `PreToolUse` | `tool.pre` | 工具调用前（门禁） |
| `PostToolUse` | `tool.post` | 工具调用后（status 通常 unknown，由 hook 判定） |
| `PostToolUseFailure` | `tool.post` | 工具调用失败（status=failed，事件名即证据） |
| `Stop` | `session.stop` | 会话结束 |
| `PreCompact` | `session.precompact` | 上下文压缩前 |
| `SubagentStop` | `subagent.stop` | 子代理结束 |
| 其他 | `unknown` | 无法识别的事件名 |

## transport 适配器约定

- 每个工具一个适配器：`engine/scripts/transport/claude-code.cjs` / `workbuddy.cjs` / `codex.cjs`，统一从 `index.cjs` 导出 `parse(rawPayload)` → `harness-event-v1` 对象。
- claude-code：读 stdin JSON（hook 事件），字段映射 `tool_name→toolName`、`tool_input→toolInput`、`tool_use_id→toolUseId`、`session_id→sessionId`。
- workbuddy：插件 hooks.json 事件与 Claude 同构，字段形状按真实载荷对齐（8 类事件已实测触发，字段细节待实测确认后冻结）。
- codex：**无 hook**，stdin-less —— 输入源为文件/参数（提交前门禁场景），适配器负责从文件构造事件。
- 每 transport 必须带一套 fixture（含缺 status 用例），见 `engine/scripts/test-hooks/fixtures/transport-*/`。

## hook 接入方式

```js
// 旧：直接读 stdin 解析 Claude payload（36 处耦合，逐步收敛）
// 新：
const { parse } = require('../transport'); // engine/scripts/transport/index.cjs
const event = parse(rawPayload);           // → harness-event-v1 对象
```

迁移节奏：manifest/registrations 先收敛（payloadSchema + transport 字段），再逐 hook 切换；试点 hook 见任务 #6。
