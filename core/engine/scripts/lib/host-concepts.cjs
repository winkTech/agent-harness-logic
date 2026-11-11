'use strict';

/**
 * core/engine/scripts/lib/host-concepts.cjs — 宿主概念唯一事实源（Phase 2.1）
 *
 * 方案 §6 步骤 2.1：把散在 15 处的「事件名 / 工具名 / 能力谓词 / matcher」
 * 硬编码收敛为三层导出。新增一个宿主 = 在 HOST_DIALECTS 加一列，而不是
 * 全文搜索改 15 个文件。
 *
 *   ACTIONS         通用动作名（§3.7 manifest v3 的 action 字段词表）
 *   TOOL_CAPABILITY 工具名 → write/shell/read/notify 谓词 + 派生集合
 *   HOST_DIALECTS   每宿主方言表（事件名↔action、matcher 规则、工具别名）
 *
 * 消费方：
 *   - transport/{claude-code,workbuddy,codex}.cjs 的事件映射（逐步迁入）
 *   - 各 hook 的受控工具集（CONTROLLED_TOOLS 三副本）
 *   - bench-hooks 的 matcher→工具名解析（替代反推补偿逻辑）
 *   - manifest v3（步骤 2.3）的 action/toolMatcher 字段词表
 *
 * 本模块是纯数据 + 纯函数：无 fs、无 env、无副作用，可被任何层 require。
 */

// ── 1. ACTIONS：通用动作名（宿主无关词表，§3.7） ───────────────────────────
// 与 transport 层的中性 eventType 的关系：eventType 是「发生时刻」语义
// (tool.pre/tool.post/...)，ACTION 是 manifest 注册语义。两套词表按需并存；
// 合并裁决推迟到 manifest v3 落地（步骤 2.3）时由渲染器消费方定。
const ACTIONS = Object.freeze([
  'before_tool',        // 工具调用前（claude: PreToolUse）
  'after_tool',         // 工具调用后（claude: PostToolUse）
  'after_tool_failure', // 工具失败后（claude: PostToolUseFailure）
  'prompt_submit',      // 用户提交提示（claude: UserPromptSubmit）
  'session_start',      // 会话启动（claude: SessionStart）
  'turn_end',           // 回合结束（claude: Stop；grok/codex 无原生等价物）
  'pre_compact',        // 压缩前（claude: PreCompact）
  'subagent_end',       // 子代理结束（claude: SubagentStop）
]);

// ── 2. TOOL_CAPABILITY：工具名 → 能力谓词 ─────────────────────────────────
// 谓词只描述「这个工具能做什么」，不含任何宿主判断。工具名一律以
// claude-code 方言为规范形（HOST_DIALECTS 负责别名翻译）。
const WRITE_TOOLS = Object.freeze([
  'Edit', 'Write', 'MultiEdit', 'NotebookEdit',
]);
const SHELL_TOOLS = Object.freeze([
  'Bash', 'PowerShell',
]);
const READ_TOOLS = Object.freeze([
  'Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'TodoRead',
]);
const NOTIFY_TOOLS = Object.freeze([
  'AskUserQuestion', 'PushNotification', 'SendMessage', 'TodoWrite', 'ToolSearch',
]);
const DELEGATION_TOOLS = Object.freeze([
  'Agent', 'Task', 'Workflow',
]);

/** 工具名 → 能力谓词数组（一个工具可具有多谓词）。 */
const TOOL_CAPABILITY = Object.freeze((() => {
  const map = new Map();
  const add = (tools, cap) => { for (const t of tools) { const list = map.get(t) || []; list.push(cap); map.set(t, list); } };
  add(WRITE_TOOLS, 'write');
  add(SHELL_TOOLS, 'shell');
  add(READ_TOOLS, 'read');
  add(NOTIFY_TOOLS, 'notify');
  add(DELEGATION_TOOLS, 'write');   // 委派产生产物/任务，按 write 谓词约束
  return map;
})());

/** 单工具能力查询：hasCapability('Bash','shell') === true。 */
function hasCapability(toolName, capability) {
  const caps = TOOL_CAPABILITY.get(String(toolName || ''));
  return Boolean(caps && caps.includes(capability));
}

// ── 派生集合（既有 hook 的语义分组，自此单一事实源） ────────────────────────
// 注意：JS 的 Object.freeze 挡不住 Set.add()（freeze 只冻结自有属性，Set 的
// 内部槽不受影响）。真正的不可变 = 模块内私有 Set + 导出冻结成员数组 + 判定
// 函数；消费方一律走判定函数，不共享可变 Set 实例。
const CONTROLLED_TOOL_LIST = ['Bash', 'Edit', 'Write', 'MultiEdit', 'Agent', 'Task', 'Workflow'];
const CONTROLLED = new Set(CONTROLLED_TOOL_LIST);
const READ_ONLY_TOOL_LIST = [...READ_TOOLS, 'AskUserQuestion']; // watchdog 原表（含 AskUserQuestion 重叠）
const READ_ONLY = new Set(READ_ONLY_TOOL_LIST);
const DIRECT_PROGRESS_TOOL_LIST = [...WRITE_TOOLS, 'Agent', 'Workflow'];
const DIRECT_PROGRESS = new Set(DIRECT_PROGRESS_TOOL_LIST);
const LONG_TASK_TOOL_LIST = [...DELEGATION_TOOLS];
const LONG_TASK = new Set(LONG_TASK_TOOL_LIST);
const NOTIFY_TOOL_LIST = [...NOTIFY_TOOLS];
const NOTIFY_SET = new Set(NOTIFY_TOOL_LIST);

/** 受控工具（透明度账本/合同门/清单门共用，原三副本）。 */
function isControlledTool(toolName) { return CONTROLLED.has(toolName); }
/** 只读工具（进度看门狗「无进展信号」）。 */
function isReadOnlyTool(toolName) { return READ_ONLY.has(toolName); }
/** 直接进展工具（进度看门狗）。 */
function isDirectProgressTool(toolName) { return DIRECT_PROGRESS.has(toolName); }
/** 长任务工具。 */
function isLongTaskTool(toolName) { return LONG_TASK.has(toolName); }
/** 通知形态工具。 */
function isNotifyTool(toolName) { return NOTIFY_SET.has(toolName); }

// 兼容视图：冻结数组（可迭代/可 size 判断，但不可变）。
const CONTROLLED_TOOLS = Object.freeze([...CONTROLLED_TOOL_LIST]);
const READ_ONLY_TOOLS = Object.freeze([...READ_ONLY_TOOL_LIST]);
const DIRECT_PROGRESS_TOOLS = Object.freeze([...DIRECT_PROGRESS_TOOL_LIST]);
const LONG_TASK_TOOLS = Object.freeze([...LONG_TASK_TOOL_LIST]);
const NOTIFY_TOOL_NAMES = Object.freeze([...NOTIFY_TOOL_LIST]);

// ── 3. HOST_DIALECTS：每宿主方言表 ────────────────────────────────────────
// 事件名映射：nativeEvent ↔ action（ACTIONS 词表）。
// SessionStart source 枚举：claude-code 的 matcher 子值（startup|resume|clear|compact|fork）。
// 工具别名：nativeTool → 规范形（claude-code 方言）。
const HOST_DIALECTS = Object.freeze({
  'claude-code': Object.freeze({
    /** native 事件名 → action（§3.7 词表）。 */
    events: Object.freeze({
      PreToolUse: 'before_tool',
      PostToolUse: 'after_tool',
      PostToolUseFailure: 'after_tool_failure',
      UserPromptSubmit: 'prompt_submit',
      SessionStart: 'session_start',
      Stop: 'turn_end',
      PreCompact: 'pre_compact',
      SubagentStop: 'subagent_end',
    }),
    /** SessionStart matcher 的合法 source 子值（registrations.json 实况）。 */
    sessionStartSources: Object.freeze(['startup', 'resume', 'clear', 'compact', 'fork']),
    /** 工具名即规范形，无别名。 */
    toolAliases: Object.freeze({}),
    /** matcher 表达式展开规则：'|' 分隔多值；'*' 通配。 */
    matcherSeparator: '|',
  }),
  workbuddy: Object.freeze({
    // WorkBuddy hook 事件与 Claude Code 同构（M3 已对真实插件样例核对），
    // 事件方言表复用同一映射；差异仅在工具命名空间（见 toolAliases）。
    events: Object.freeze({
      PreToolUse: 'before_tool',
      PostToolUse: 'after_tool',
      PostToolUseFailure: 'after_tool_failure',
      UserPromptSubmit: 'prompt_submit',
      SessionStart: 'session_start',
      Stop: 'turn_end',
      PreCompact: 'pre_compact',
      SubagentStop: 'subagent_end',
    }),
    sessionStartSources: Object.freeze(['startup', 'resume', 'clear', 'compact']),
    toolAliases: Object.freeze({
      // WorkBuddy 内置工具名 → 规范形（逐步补充；未列出的原样透传）。
      Execute: 'Bash',
      Edit: 'Edit',
      Write: 'Write',
    }),
    matcherSeparator: '|',
  }),
  codex: Object.freeze({
    // Codex 侧事件以中性 eventType 直供（transport/codex.cjs），
    // 无 native hook 事件名层；此表给出 action ↔ eventType 对照。
    events: Object.freeze({}),
    /** eventType → action（codex 无 native 层，直接按 eventType 走）。 */
    eventTypeToAction: Object.freeze({
      'tool.pre': 'before_tool',
      'tool.post': 'after_tool',
      'session.start': 'session_start',
      'prompt.submit': 'prompt_submit',
    }),
    sessionStartSources: Object.freeze([]),
    toolAliases: Object.freeze({}),
    matcherSeparator: null,
  }),
  grok: Object.freeze({
    // Phase 3.2：Grok 经 claude settings 兼容并入（claude 式 hook 注册
    // 四系统同构——§3.2 契约 3）。差异点收敛在此：
    //   - SessionStart matcher 词汇差异（grok 用 new|load，等价 claude startup|resume）
    //   - 工具别名（Grok 工具面 run_terminal_command；引擎读 canonical Bash）
    //   - async 剥离（Grok 对 async 条目按前台执行——长钩子经 hostPresets.grok 跳过）
    events: Object.freeze({
      PreToolUse: 'before_tool',
      PostToolUse: 'after_tool',
      PostToolUseFailure: 'after_tool_failure',
      SessionStart: 'session_start',
      Stop: 'turn_end',
    }),
    eventTypeToAction: Object.freeze({}),
    sessionStartSources: Object.freeze(['new', 'load']),
    /** claude matcher → grok matcher 词汇翻译。 */
    matcherTranslation: Object.freeze({
      startup: 'new',
      resume: 'load',
    }),
    /** native（grok）→ canonical 工具名。 */
    toolAliases: Object.freeze({
      run_terminal_command: 'Bash',
    }),
    matcherSeparator: '|',
  }),
});

// ── 查询函数 ────────────────────────────────────────────────────────────────

/** native 事件名 → action；未知事件返回 null（fail-soft，调用方自决）。 */
function actionForNativeEvent(nativeEvent, host = 'claude-code') {
  const dialect = HOST_DIALECTS[host];
  if (!dialect) return null;
  return dialect.events[nativeEvent] || null;
}

/** 工具别名翻译：native → 规范形；未登记原样返回。 */
function canonicalToolName(nativeTool, host = 'claude-code') {
  const dialect = HOST_DIALECTS[host];
  const name = String(nativeTool || '');
  if (!dialect || !dialect.toolAliases) return name;
  return dialect.toolAliases[name] || name;
}

/**
 * SessionStart matcher → 枚举 source 列表。
 * 'startup|resume|clear|compact|fork' → ['startup','resume','clear','compact','fork']
 * 非法子值原样保留（fail-soft——宿主可能扩展枚举，门禁只关心已知值）。
 */
function sessionStartSourcesFromMatcher(matcher, host = 'claude-code') {
  const dialect = HOST_DIALECTS[host];
  if (!dialect || !dialect.matcherSeparator) return [];
  return String(matcher || '')
    .split(dialect.matcherSeparator)
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * 工具 matcher → 规范工具名列表（bench-hooks 反推补偿的合同化替代）。
 * 'Edit|Write|MultiEdit|Bash|PowerShell|Skill' → ['Edit','Write','MultiEdit','Bash','PowerShell']
 * '*' → 空数组（通配，调用方自行取默认工具）。
 */
function toolsFromMatcher(matcher, host = 'claude-code') {
  const dialect = HOST_DIALECTS[host];
  if (!dialect || !dialect.matcherSeparator) return [];
  const raw = String(matcher || '').trim();
  if (!raw || raw === '*') return [];
  return raw
    .split(dialect.matcherSeparator)
    .map((v) => canonicalToolName(v.trim(), host))
    .filter(Boolean);
}

module.exports = {
  // 词表
  ACTIONS,
  TOOL_CAPABILITY,
  HOST_DIALECTS,
  // 能力谓词查询
  hasCapability,
  // 派生集合：判定函数（推荐）+ 冻结数组视图（可迭代，不可变）
  isControlledTool,
  isReadOnlyTool,
  isDirectProgressTool,
  isLongTaskTool,
  isNotifyTool,
  CONTROLLED_TOOLS,
  READ_ONLY_TOOLS,
  DIRECT_PROGRESS_TOOLS,
  LONG_TASK_TOOLS,
  NOTIFY_TOOL_NAMES,
  // 原始分组（数组形态，供展开/序列化）
  WRITE_TOOLS,
  SHELL_TOOLS,
  READ_TOOLS,
  NOTIFY_TOOLS,
  DELEGATION_TOOLS,
  // 方言查询
  actionForNativeEvent,
  canonicalToolName,
  sessionStartSourcesFromMatcher,
  toolsFromMatcher,
};
