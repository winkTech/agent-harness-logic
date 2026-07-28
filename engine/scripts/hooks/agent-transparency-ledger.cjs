#!/usr/bin/env node
'use strict';

const { HARNESS_ROOT } = require('../lib/harness-root.cjs');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  atomicWriteJson,
  findProjectRoot,
  isInsidePath,
  isSamePath,
  payloadCwd,
  payloadFilePath,
  readJson,
  resolvePath,
} = require('../lib/project-scope.cjs');

const HOME = HARNESS_ROOT;
const MAX_PREVIEW_CHARS = 220;
const MAX_TRANSCRIPT_TAIL = 1024 * 1024;
const configuredTranscriptMax = Number.parseInt(
  process.env.CLAUDE_TRANSPARENCY_TRANSCRIPT_MAX_BYTES || String(4 * 1024 * 1024),
  10,
);
const TRANSCRIPT_MAX_BYTES = Number.isFinite(configuredTranscriptMax)
  ? Math.min(32 * 1024 * 1024, Math.max(MAX_TRANSCRIPT_TAIL, configuredTranscriptMax))
  : 4 * 1024 * 1024;
const TRANSCRIPT_TAIL_WINDOWS = [...new Set([
  MAX_TRANSCRIPT_TAIL,
  4 * 1024 * 1024,
  12 * 1024 * 1024,
  32 * 1024 * 1024,
  TRANSCRIPT_MAX_BYTES,
].filter((value) => value <= TRANSCRIPT_MAX_BYTES))].sort((a, b) => a - b);
const MAX_EVENTS_BYTES = 5 * 1024 * 1024;

const CONTROLLED_TOOLS = new Set(['Bash', 'Edit', 'Write', 'MultiEdit', 'Agent', 'Task', 'Workflow']);
const HIGH_RISK_BASH_COMMAND = /\b(?:git\s+(?:push|reset\s+--hard|clean\s+-\S*f|branch\s+-D)|gh\s+(?:pr\s+(?:create|merge)|issue\s+(?:create|edit|close)|release\s+create|repo\s+delete)|npm\s+publish|docker\s+(?:push|system\s+prune)|kubectl\s+(?:apply|delete)|terraform\s+apply)\b|\b(?:curl|Invoke-RestMethod|irm)\b[^\r\n]*(?:-X|--request|Method)\s*(?:POST|PUT|PATCH|DELETE)\b|\b(?:rm\s+-rf|Remove-Item\b[^\r\n]*-Recurse)\b/i;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function threadIdFrom(payload) {
  return String(
    payload?.session_id
    || payload?.sessionId
    || payload?.thread_id
    || payload?.threadId
    || payload?.conversation?.thread_id
    || payload?.conversation?.threadId
    || process.env.CLAUDE_SESSION_ID
    || ''
  ).trim();
}

function decodeDelegationMarkup(value) {
  return String(value || '')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function delegationFrom(userInstruction) {
  const text = decodeDelegationMarkup(userInstruction).trim();
  if (!/^<codex_delegation(?:\s[^>]*)?>[\s\S]*<\/codex_delegation>$/i.test(text)) {
    return { isDelegation: false, sourceThreadId: '', objective: '', malformed: false };
  }

  const sourceMatch = text.match(/<source_thread_id>\s*([^<]+?)\s*<\/source_thread_id>/i);
  const inputMatch = text.match(/<input>\s*([\s\S]*?)\s*<\/input>/i);
  const sourceThreadId = String(sourceMatch?.[1] || '').trim();
  const validSource = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(sourceThreadId);
  return {
    isDelegation: true,
    sourceThreadId: validSource ? sourceThreadId : '',
    objective: String(inputMatch?.[1] || '').trim(),
    malformed: !validSource,
  };
}

function loopScopeFrom(payload, projectRoot, userInstruction) {
  const currentThreadId = threadIdFrom(payload);
  const delegation = delegationFrom(userInstruction);
  let status = 'not-delegated';
  let reason = 'latest instruction belongs to the current thread';

  if (delegation.isDelegation) {
    if (delegation.malformed) {
      status = 'blocked';
      reason = 'delegation source_thread_id is missing or invalid';
    } else if (!currentThreadId) {
      status = 'blocked';
      reason = 'current thread identity is unavailable';
    } else if (delegation.sourceThreadId !== currentThreadId) {
      status = 'blocked';
      reason = 'cross-thread delegation source does not match current thread';
    } else {
      status = 'allowed';
      reason = 'delegation source matches current thread';
    }
  }

  return {
    status,
    reason,
    isDelegation: delegation.isDelegation,
    currentThreadId,
    sourceThreadId: delegation.sourceThreadId,
    projectRoot,
    objectiveHash: sha256(delegation.objective || userInstruction),
  };
}

function readStdin() {
  try {
    if (process.stdin.isTTY) return '';
    return fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return '';
  }
}

function parsePayload(raw) {
  if (!raw || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function toolNameFrom(payload) {
  if (typeof payload?.tool === 'string') return payload.tool;
  return payload?.tool?.name || payload?.tool_name || payload?.name || '';
}

function eventNameFrom(payload) {
  return payload?.hook_event_name || payload?.event || '';
}

function toolInputFrom(payload) {
  return payload?.tool_input || payload?.tool?.input || payload?.input || payload?.arguments || {};
}

function canonicalJson(value) {
  const normalize = (entry) => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (!entry || typeof entry !== 'object') return entry;
    const out = {};
    for (const key of Object.keys(entry).sort()) {
      if (entry[key] !== undefined) out[key] = normalize(entry[key]);
    }
    return out;
  };
  return JSON.stringify(normalize(value));
}

function commandFrom(payload) {
  const input = toolInputFrom(payload);
  return String(input.command || payload?.command || '').trim();
}

function contentFrom(payload) {
  const input = toolInputFrom(payload);
  return String(input.content || input.new_string || payload?.content || '');
}

function responseFrom(payload) {
  return payload?.tool_response || payload?.tool_result || payload?.response || {};
}

function normalizeStatus(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function redact(value) {
  return String(value || '')
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, 'sk-[REDACTED]')
    .replace(/(ANTHROPIC_AUTH_TOKEN|OPENAI_API_KEY|DEEPSEEK_API_KEY|API_TOKEN|API_KEY|SECRET|TOKEN)\s*=\s*("[^"]+"|'[^']+'|\S+)/gi, '$1=[REDACTED]')
    .replace(/(authorization:\s*bearer\s+)[A-Za-z0-9._-]+/gi, '$1[REDACTED]');
}

function preview(value, limit = MAX_PREVIEW_CHARS) {
  const text = redact(value).replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function slug(value) {
  const safe = String(value || '')
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return safe || 'local';
}

function projectSlug(projectRoot) {
  return slug(path.resolve(projectRoot || process.cwd()).replace(/[^A-Za-z0-9]+/g, '-'));
}

function relativeTo(root, value) {
  if (!value) return '';
  try {
    const rel = path.relative(root, value);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.replace(/\\/g, '/') : value;
  } catch {
    return value;
  }
}

function resolveTranscriptPath(payload) {
  const explicit = payload?.transcript_path
    || payload?.transcriptPath
    || payload?.conversation?.transcript_path
    || payload?.session?.transcript_path
    || process.env.CLAUDE_TRANSCRIPT_PATH
    || '';
  if (explicit && fs.existsSync(explicit)) return explicit;

  const sessionDir = payload?.session_dir || process.env.CLAUDE_SESSION_DIR || '';
  if (sessionDir && fs.existsSync(sessionDir)) {
    for (const name of ['transcript.jsonl', 'conversation.jsonl', 'messages.jsonl']) {
      const candidate = path.join(sessionDir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  const sessionId = payload?.session_id || payload?.sessionId || process.env.CLAUDE_SESSION_ID || '';
  if (!sessionId) return '';

  const projectsDir = path.join(HOME, 'projects');
  if (!fs.existsSync(projectsDir)) return '';
  const expected = `${sessionId}.jsonl`.toLowerCase();
  const stack = [projectsDir];
  const deadline = Date.now() + 400;
  while (stack.length > 0 && Date.now() < deadline) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === expected) return fullPath;
      if (entry.isDirectory()) stack.push(fullPath);
    }
  }
  return '';
}

function readTail(filePath, maxBytes = MAX_TRANSCRIPT_TAIL) {
  const stat = fs.statSync(filePath);
  const start = Math.max(0, stat.size - maxBytes);
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    return buffer.toString('utf8').replace(/^\uFEFF/, '');
  } finally {
    fs.closeSync(fd);
  }
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part?.type === 'text') return part.text || '';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

// 逐级扩大尾部窗口, 直到找到用户消息或读完全文。
// 固定 1MB 窗口在长 agent 轮次上会失效: 大量工具输出把最近一条用户消息挤出
// 窗口, 合同随即标 missing-user-instruction 并拦下动作 —— 恰好在最复杂、最
// 该留痕的任务上失灵。扩大只在小窗口找不到时发生, 常规调用仍只读 1MB。
function latestUserText(transcriptPath) {
  if (!transcriptPath) return '';
  let size = 0;
  try {
    size = fs.statSync(transcriptPath).size;
  } catch {
    return '';
  }
  for (const window of TRANSCRIPT_TAIL_WINDOWS) {
    const found = scanLatestUserText(transcriptPath, window);
    if (found) return found;
    if (window >= size) break;   // 已读完全文, 再扩大无意义
  }
  return '';
}

function scanLatestUserText(transcriptPath, maxBytes) {
  let text = '';
  try {
    text = readTail(transcriptPath, maxBytes);
  } catch {
    return '';
  }
  const lines = text.split(/\r?\n/).reverse();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{')) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const role = event?.message?.role || event?.role || '';
    const type = event?.type || '';
    if (role !== 'user' && type !== 'user') continue;
    const userText = textFromContent(event?.message?.content ?? event?.content).trim();
    if (userText) return userText;
  }
  return '';
}

function userInstructionFrom(payload, transcriptPath) {
  return String(
    payload?.user_message
    || payload?.userMessage
    || payload?.prompt
    || process.env.CLAUDE_USER_MESSAGE
    || latestUserText(transcriptPath)
    || ''
  ).trim();
}

function detectSignals(text) {
  const lower = text.toLowerCase();
  const signals = [];
  const add = (name, pattern) => {
    if (pattern.test(lower)) signals.push(name);
  };
  add('rtl', /\.(sv|v|vh|svh)\b|rtl|hdl|verilog|systemverilog|vivado|xsim|vsim|fpga/);
  add('python', /\.py\b|python|pytest|ruff/);
  add('debug', /debug|bug|fail|failure|fix|repair|investigate|\u8c03\u8bd5|\u4fee\u590d|\u5931\u8d25/);
  add('review', /review|audit|inspect|\u5ba1\u8ba1|\u8bc4\u5ba1|\u68c0\u67e5/);
  add('knowledge', /knowledge|memory|rag|pdf|paper|docs|\u8bba\u6587|\u77e5\u8bc6|\u8bb0\u5fc6/);
  add('git', /\bgit\b|commit|push|pull request|pr\b/);
  return signals;
}

function inferTaskType(signals) {
  if (signals.includes('rtl')) return signals.includes('debug') ? 'rtl_debug' : 'rtl_project';
  if (signals.includes('python')) return signals.includes('debug') ? 'python_debug' : 'python_project';
  if (signals.includes('review')) return 'code_review';
  if (signals.includes('knowledge')) return 'knowledge_work';
  if (signals.includes('git')) return 'git_work';
  return 'project_work';
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function requiredSkills(taskType, signals) {
  const skills = [];
  if (signals.includes('rtl')) skills.push('hdl-coding', 'rag-skill');
  if (signals.includes('debug')) skills.push('debugging');
  if (signals.includes('review')) skills.push('code-review');
  if (signals.includes('knowledge')) skills.push('rag-skill');
  if (signals.includes('python')) skills.push('modern-python');
  if (signals.includes('git')) skills.push('git-expert');
  if (taskType === 'project_work') skills.push('code-search');
  return unique(skills);
}

function requiredRules(signals) {
  // 规则文件住在 docs/rules/ 而不是 .claude/rules/: 后者会被平台当作常驻全局
  // 指令全文注入每个会话, 与 rule-loader 的按需 capsule 双重加权。
  const rules = ['docs/rules/00-core.md', 'docs/rules/03-gates.md'];
  if (signals.includes('rtl')) rules.push('docs/rules/01-hdl.md');
  if (signals.includes('python')) rules.push('docs/rules/02-python.md');
  if (signals.includes('git')) rules.push('docs/rules/04-git.md');
  return unique(rules);
}

function skippedSkills(required) {
  const requiredSet = new Set(required);
  const candidates = [
    ['presentation', 'current task does not require slides or diagrams'],
    ['pdf', 'current task does not require PDF extraction'],
    ['browser', 'current task does not require browser interaction'],
    ['computer-use', 'current task does not require desktop UI control'],
  ];
  return candidates
    .filter(([skill]) => !requiredSet.has(skill))
    .map(([skill, reason]) => ({ skill, reason }));
}

function buildContext(payload) {
  const cwd = payloadCwd(payload);
  const filePath = payloadFilePath(payload, cwd);
  const projectRoot = findProjectRoot(filePath || cwd, { fallback: cwd });
  const transcriptPath = resolveTranscriptPath(payload);
  const userInstruction = userInstructionFrom(payload, transcriptPath);
  const toolName = toolNameFrom(payload);
  const eventName = eventNameFrom(payload);
  const command = commandFrom(payload);
  const content = contentFrom(payload);
  const toolInputJson = canonicalJson(toolInputFrom(payload));
  const combined = [userInstruction, filePath, command, content.slice(0, 2000)].filter(Boolean).join('\n');
  const signals = detectSignals(combined);
  const taskType = inferTaskType(signals);
  const runId = slug(
    process.env.CLAUDE_TRANSPARENCY_RUN_ID
    || payload?.session_id
    || payload?.sessionId
    || `local-${new Date().toISOString().slice(0, 10)}-${sha256(projectRoot).slice(0, 10)}`
  );
  const explicitRunDir = process.env.CLAUDE_TRANSPARENCY_RUN_DIR;
  const runsRoot = resolvePath(
    process.env.CLAUDE_TRANSPARENCY_RUNS_DIR || path.join(HOME, 'var', 'runs'),
    projectRoot,
  );
  const runDir = explicitRunDir
    ? resolvePath(process.env.CLAUDE_TRANSPARENCY_RUN_DIR, projectRoot)
    : path.join(runsRoot, runId);
  const loopScope = loopScopeFrom(payload, projectRoot, userInstruction);

  return {
    cwd,
    filePath,
    projectRoot,
    transcriptPath,
    userInstruction,
    toolName,
    eventName,
    command,
    content,
    toolInputSha256: sha256(toolInputJson),
    toolInputBytes: Buffer.byteLength(toolInputJson),
    signals,
    taskType,
    runId,
    runDir,
    runsRoot,
    managedRunsRoot: !explicitRunDir,
    loopScope,
  };
}

function shouldCapture(ctx) {
  if (process.env.CLAUDE_TRANSPARENCY_CAPTURE_ALL === '1') return true;
  if ((ctx.eventName || '') === 'Stop') return true;
  return CONTROLLED_TOOLS.has(ctx.toolName);
}

function actionContractMode() {
  const value = String(process.env.CLAUDE_TOOL_ACTION_CONTRACT_MODE || 'high-risk').toLowerCase();
  if (['off', 'disabled', 'none'].includes(value)) return 'off';
  return value === 'all' ? 'all' : 'high-risk';
}

function requiresActionContract(ctx) {
  const mode = actionContractMode();
  if (!CONTROLLED_TOOLS.has(ctx.toolName)) return false;
  if (ctx.loopScope?.isDelegation) return true;
  if (mode === 'off') return false;
  if (mode === 'all') return true;
  return ctx.toolName === 'Bash' && HIGH_RISK_BASH_COMMAND.test(ctx.command || '');
}

function mayRequireActionContract(payload) {
  const mode = actionContractMode();
  if (mode === 'off') return false;
  const toolName = toolNameFrom(payload);
  if (!CONTROLLED_TOOLS.has(toolName)) return false;
  if (mode === 'all') return true;
  if (toolName === 'Bash' && HIGH_RISK_BASH_COMMAND.test(commandFrom(payload))) return true;
  if (['Agent', 'Task', 'Workflow'].includes(toolName)) return true;
  const explicitInstruction = String(
    payload?.user_message
    || payload?.userMessage
    || payload?.prompt
    || process.env.CLAUDE_USER_MESSAGE
    || ''
  );
  return /^\s*<codex_delegation(?:\s[^>]*)?>/i.test(decodeDelegationMarkup(explicitInstruction));
}

function instructionMetadata(value) {
  const text = String(value || '');
  return {
    instructionCaptured: Boolean(text),
    instructionSha256: text ? sha256(text) : '',
    instructionBytes: text ? Buffer.byteLength(text) : 0,
  };
}

function writeTaskContract(ctx) {
  const filePath = path.join(ctx.runDir, 'task-contract.json');
  const previous = readJson(filePath, {});
  const priorInstruction = previous.userInstruction || '';
  const instruction = instructionMetadata(ctx.userInstruction || priorInstruction);
  const contract = {
    schemaVersion: 1,
    runId: ctx.runId,
    projectRoot: ctx.projectRoot,
    taskType: ctx.taskType,
    ...instruction,
    source: instruction.instructionCaptured ? 'transcript-or-env' : previous.source || 'unavailable',
    ambiguityStatus: instruction.instructionCaptured ? 'captured' : 'unknown',
    instructionPolicy: 'model statements are not evidence; tool logs and gate artifacts are evidence',
    loopScope: ctx.loopScope,
    createdAt: previous.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  atomicWriteJson(filePath, contract);
  return contract;
}

function writeSkillPlan(ctx) {
  const filePath = path.join(ctx.runDir, 'skill-plan.json');
  const skills = requiredSkills(ctx.taskType, ctx.signals);
  const rules = requiredRules(ctx.signals);
  const plan = {
    schemaVersion: 1,
    runId: ctx.runId,
    taskType: ctx.taskType,
    requiredSkills: skills,
    loadedRules: rules,
    notLoaded: skippedSkills(skills),
    signals: ctx.signals,
    evidenceSource: ctx.userInstruction ? 'user-instruction + current tool payload' : 'current tool payload',
    updatedAt: new Date().toISOString(),
  };
  atomicWriteJson(filePath, plan);
  return plan;
}

function buildPlan(ctx) {
  const skills = requiredSkills(ctx.taskType, ctx.signals);
  return {
    requiredSkills: skills,
    loadedRules: requiredRules(ctx.signals),
  };
}

function gateStatusFile(projectRoot, relPath) {
  return path.join(projectRoot, relPath);
}

function gateFileStatus(projectRoot, relPath) {
  const filePath = gateStatusFile(projectRoot, relPath);
  const data = readJson(filePath, null);
  return {
    file: filePath,
    status: data?.status || 'missing',
    completed: data?.status === 'completed',
  };
}

function isNewCodeFile(ctx) {
  if (!['Edit', 'Write', 'MultiEdit'].includes(ctx.toolName)) return false;
  return /\.(sv|v|py)$/i.test(ctx.filePath || '');
}

function isVerificationFile(ctx) {
  const name = path.basename(ctx.filePath || '').toLowerCase();
  return /^(tb_|test_)/.test(name);
}

function verificationCommand(ctx) {
  return /\b(pytest|xsim|vsim|npm\s+test|npm\s+run\s+test|node\s+.*test-hooks|go\s+test|cargo\s+test)\b/i.test(ctx.command || '');
}

function buildGateLedger(ctx, plan) {
  const requirements = gateFileStatus(ctx.projectRoot, path.join('var', 'gates', 'requirements-gate.json'));
  const verificationQuality = gateFileStatus(ctx.projectRoot, path.join('var', 'gates', 'verification-quality.json'));
  const gates = [
    { name: 'task-contract', status: 'created', evidence: 'task-contract.json' },
    { name: 'skill-plan', status: 'created', evidence: 'skill-plan.json' },
    { name: 'rule-trace', status: CONTROLLED_TOOLS.has(ctx.toolName) ? 'created' : 'not-applicable', evidence: 'rule-trace.md' },
    {
      name: 'requirements-gate',
      status: isNewCodeFile(ctx) ? (requirements.completed ? 'completed' : 'required-not-completed') : 'not-applicable',
      evidence: relativeTo(ctx.projectRoot, requirements.file),
    },
    {
      name: 'verification-quality-gate',
      status: isVerificationFile(ctx) ? (verificationQuality.completed ? 'completed' : 'required-not-completed') : 'not-applicable',
      evidence: relativeTo(ctx.projectRoot, verificationQuality.file),
    },
    {
      name: 'verification-evidence',
      status: verificationCommand(ctx) ? 'tool-command-observed' : 'pending-or-not-applicable',
      evidence: 'verification-ledger.json',
    },
  ];

  return {
    schemaVersion: 1,
    runId: ctx.runId,
    taskType: ctx.taskType,
    updatedAt: new Date().toISOString(),
    gates,
    summary: {
      requiredSkills: plan.requiredSkills,
      loadedRules: plan.loadedRules,
      currentTool: ctx.toolName,
      currentEvent: ctx.eventName,
    },
  };
}

function writeGateLedger(ctx, plan) {
  const ledger = buildGateLedger(ctx, plan);
  atomicWriteJson(path.join(ctx.runDir, 'gate-ledger.json'), ledger);
  return ledger;
}

function gateMap(ledger) {
  const out = {};
  for (const gate of ledger.gates || []) {
    out[gate.name] = {
      status: gate.status,
      evidence: gate.evidence,
    };
  }
  return out;
}

function writeToolActionContract(ctx, plan, ledger) {
  if (!requiresActionContract(ctx)) return null;
  const filePath = path.join(ctx.runDir, 'tool-action-contract.json');
  const instruction = instructionMetadata(ctx.userInstruction);
  const contract = {
    schemaVersion: 1,
    createdBy: 'agent-transparency-ledger',
    runId: ctx.runId,
    event: ctx.eventName || 'unknown',
    tool: ctx.toolName || 'unknown',
    taskType: ctx.taskType,
    loopScope: ctx.loopScope,
    action: summarizeAction(ctx),
    match: {
      status: instruction.instructionCaptured ? 'user-instruction-captured' : 'missing-user-instruction',
      userInstructionSha256: instruction.instructionSha256,
      userInstructionBytes: instruction.instructionBytes,
      policy: 'controlled tools require a fresh machine-readable action contract before execution',
    },
    gates: gateMap(ledger),
    requiredSkills: plan.requiredSkills,
    loadedRules: plan.loadedRules,
    toolPayload: {
      cwd: ctx.cwd,
      inputSha256: ctx.toolInputSha256,
      inputBytes: ctx.toolInputBytes,
      filePathSha256: ctx.filePath ? sha256(ctx.filePath) : '',
      commandSha256: ctx.command ? sha256(ctx.command) : '',
      contentSha256: ctx.content ? sha256(ctx.content) : '',
      contentBytes: ctx.content ? Buffer.byteLength(ctx.content) : 0,
    },
    evidencePolicy: {
      selfReportedVerificationIsEvidence: false,
      acceptedEvidence: ['tool-output', 'tool-log', 'gate-ledger', 'test-manifest'],
    },
    updatedAt: new Date().toISOString(),
  };
  atomicWriteJson(filePath, contract);
  return contract;
}

function buildRuleTrace(ctx, plan, ledger) {
  const fileRel = relativeTo(ctx.projectRoot, ctx.filePath);
  const lines = [
    '# Agent Rule Trace',
    '',
    `Run: ${ctx.runId}`,
    `Updated: ${new Date().toISOString()}`,
    `Task type: ${ctx.taskType}`,
    `Tool: ${ctx.eventName || 'unknown'} ${ctx.toolName || 'unknown'}`,
    fileRel ? `File: ${fileRel}` : '',
    ctx.command ? `Command: ${preview(ctx.command)}` : '',
    '',
    '## Instruction Source',
    ctx.userInstruction
      ? `- Captured: sha256=${sha256(ctx.userInstruction)} bytes=${Buffer.byteLength(ctx.userInstruction)}`
      : '- Captured: unavailable in hook payload/transcript',
    '',
    '## Required Skills',
    ...(plan.requiredSkills.length ? plan.requiredSkills.map((skill) => `- ${skill}: required`) : ['- none inferred']),
    '',
    '## Loaded Rules',
    ...(plan.loadedRules.length ? plan.loadedRules.map((rule) => `- ${rule}`) : ['- none inferred']),
    '',
    '## File-Specific Checks',
  ].filter(Boolean);

  if (/\.(sv|v|vh|svh)$/i.test(ctx.filePath || '')) {
    lines.push(
      '- ri_ input register rule: required for RTL source paths; enforced by hdl-gate.cjs',
      '- ro_ output register rule: required for RTL source paths; enforced by hdl-gate.cjs',
      '- three-block FSM: required when FSM exists; audit by HDL review and simulation',
      '- synchronous reset: required unless project contract explicitly says otherwise',
      '- no latch: if/else and case/default coverage required',
      '- bit width match: must be proven by lint/sim evidence, not by model text'
    );
  } else if (/\.py$/i.test(ctx.filePath || '')) {
    lines.push(
      '- Python style: ruff/pytest evidence required for production Python changes',
      '- Hardware-debug scripts: fixtures or captured data must define success criteria'
    );
  } else {
    lines.push('- No file-specific rule family inferred for this tool payload');
  }

  lines.push(
    '',
    '## Gate Ledger',
    ...ledger.gates.map((gate) => `- ${gate.name}: ${gate.status} (${gate.evidence})`),
    '',
    '## Evidence Policy',
    '- Verification pass/fail must come from tool output, logs, or ledger entries.',
    '- Model self-claims such as pass, verified, fixed, or synthesis passed are not evidence.',
    '- Full source content is not stored here; events keep hashes and bounded previews only.',
    ''
  );

  return lines.join('\n');
}

function writeRuleTrace(ctx, plan, ledger) {
  if (!CONTROLLED_TOOLS.has(ctx.toolName)) return '';
  const trace = buildRuleTrace(ctx, plan, ledger);
  fs.writeFileSync(path.join(ctx.runDir, 'rule-trace.md'), trace, 'utf8');
  return trace;
}

function rotateEventsIfNeeded(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const configuredBytes = Number.parseInt(
      process.env.CLAUDE_TRANSPARENCY_MAX_EVENTS_BYTES || MAX_EVENTS_BYTES,
      10,
    );
    const maxBytes = Number.isFinite(configuredBytes) ? Math.max(1, configuredBytes) : MAX_EVENTS_BYTES;
    if (stat.size <= maxBytes) return;
    const suffix = `${Date.now()}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    const rotated = filePath.replace(/\.ndjson$/i, `.${suffix}.ndjson`);
    fs.renameSync(filePath, rotated);

    const configuredRotated = Number.parseInt(
      process.env.CLAUDE_TRANSPARENCY_MAX_ROTATED_EVENTS || '5',
      10,
    );
    const maxRotated = Number.isFinite(configuredRotated) ? Math.max(1, configuredRotated) : 5;
    const dir = path.dirname(filePath);
    const base = path.basename(filePath, '.ndjson');
    const rotatedFiles = fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.startsWith(`${base}.`) && entry.name.endsWith('.ndjson'))
      .map((entry) => {
        const target = path.join(dir, entry.name);
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(target).mtimeMs; } catch { /* deterministic name fallback */ }
        return { target, name: entry.name, mtimeMs };
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
    for (const entry of rotatedFiles.slice(0, Math.max(0, rotatedFiles.length - maxRotated))) {
      fs.unlinkSync(entry.target);
    }
  } catch {
    // Missing files and rotation races are harmless.
  }
}

function summarizeAction(ctx) {
  if (ctx.command) return `run command: ${preview(ctx.command)}`;
  if (ctx.filePath) return `${ctx.toolName || 'tool'} file: ${relativeTo(ctx.projectRoot, ctx.filePath)}`;
  return ctx.toolName || 'unknown tool action';
}

function buildEvent(ctx, plan) {
  const response = responseFrom({ ...ctx.payload });
  const stdout = response.stdout || '';
  const stderr = response.stderr || '';
  const content = ctx.content || '';
  return {
    schemaVersion: 1,
    ts: new Date().toISOString(),
    runId: ctx.runId,
    event: ctx.eventName || 'unknown',
    tool: ctx.toolName || 'unknown',
    taskType: ctx.taskType,
    action: summarizeAction(ctx),
    cwd: ctx.cwd,
    projectRoot: ctx.projectRoot,
    file: ctx.filePath ? relativeTo(ctx.projectRoot, ctx.filePath) : undefined,
    command: ctx.command ? { preview: preview(ctx.command), sha256: sha256(ctx.command) } : undefined,
    content: content ? { bytes: Buffer.byteLength(content), sha256: sha256(content) } : undefined,
    result: response && Object.keys(response).length > 0 ? {
      status: normalizeStatus(response.status ?? response.exit_code ?? response.exitCode),
      signal: response.signal || null,
      error: response.error ? preview(response.error) : '',
      stdoutSha256: stdout ? sha256(stdout) : undefined,
      stderrSha256: stderr ? sha256(stderr) : undefined,
    } : undefined,
    requiredSkills: plan.requiredSkills,
    loadedRules: plan.loadedRules,
  };
}

function cleanUndefined(value) {
  if (Array.isArray(value)) return value.map(cleanUndefined);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = cleanUndefined(entry);
  }
  return out;
}

function appendEvent(ctx, event) {
  const filePath = path.join(ctx.runDir, 'events.ndjson');
  rotateEventsIfNeeded(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(cleanUndefined(event))}\n`, 'utf8');
}

function pruneRunDirs(ctx) {
  if (!ctx.managedRunsRoot || !fs.existsSync(ctx.runsRoot)) return;
  const configuredMax = Number.parseInt(process.env.CLAUDE_TRANSPARENCY_MAX_RUNS || '50', 10);
  const maxRuns = Number.isFinite(configuredMax) ? Math.max(5, configuredMax) : 50;
  const dirs = fs.readdirSync(ctx.runsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dirPath = path.join(ctx.runsRoot, entry.name);
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(dirPath).mtimeMs; } catch { /* deterministic name fallback */ }
      return { dirPath, name: entry.name, mtimeMs };
    })
    .sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
  let remaining = dirs.length;
  for (const entry of dirs) {
    if (remaining <= maxRuns) break;
    if (isSamePath(entry.dirPath, ctx.runDir) || !isInsidePath(entry.dirPath, ctx.runsRoot)) continue;
    fs.rmSync(entry.dirPath, { recursive: true, force: true });
    remaining -= 1;
  }
}

function ensureRunDir(ctx) {
  fs.mkdirSync(ctx.runDir, { recursive: true });
  pruneRunDirs(ctx);
}

function run(payload, options = {}) {
  const ctx = options.context || buildContext(payload);
  ctx.payload = payload;
  if (!shouldCapture(ctx)) return ctx;
  const isPreToolUse = (ctx.eventName || '') === 'PreToolUse';
  if (isPreToolUse && !requiresActionContract(ctx)) return ctx;
  ensureRunDir(ctx);
  if (!isPreToolUse) {
    appendEvent(ctx, buildEvent(ctx, buildPlan(ctx)));
    return ctx;
  }
  const contract = writeTaskContract(ctx);
  const plan = writeSkillPlan(ctx);
  const ledger = writeGateLedger(ctx, plan);
  const toolActionContract = writeToolActionContract(ctx, plan, ledger);
  writeRuleTrace(ctx, plan, ledger);
  ctx.artifacts = {
    taskContract: contract,
    skillPlan: plan,
    gateLedger: ledger,
    toolActionContract,
  };
  appendEvent(ctx, {
    ...buildEvent(ctx, plan),
    contractStatus: contract.ambiguityStatus,
    artifacts: {
      taskContract: path.join(ctx.runDir, 'task-contract.json'),
      skillPlan: path.join(ctx.runDir, 'skill-plan.json'),
      toolActionContract: toolActionContract ? path.join(ctx.runDir, 'tool-action-contract.json') : undefined,
      ruleTrace: path.join(ctx.runDir, 'rule-trace.md'),
      gateLedger: path.join(ctx.runDir, 'gate-ledger.json'),
    },
  });
  return ctx;
}

// 同组 hook 并发执行时, 本 hook 的写入可能晚于消费者的读取。
// 供 tool-action-contract-gate 在合同缺失/过期时按同一 payload 重建;
// 不追加 events.ndjson, 避免同一次工具调用产生重复审计事件。
function ensureToolActionContract(payload) {
  const ctx = buildContext(payload);
  if (!requiresActionContract(ctx)) return null;
  ensureRunDir(ctx);
  const plan = buildPlan(ctx);
  const ledger = writeGateLedger(ctx, plan);
  return writeToolActionContract(ctx, plan, ledger);
}

function main() {
  if (process.env.CLAUDE_TRANSPARENCY_LEDGER_DISABLED === '1') process.exit(0);
  const payload = parsePayload(readStdin());
  try {
    run(payload);
  } catch (error) {
    if (process.env.CLAUDE_TRANSPARENCY_DEBUG === '1') {
      console.error(`[agent-transparency-ledger] ${error.stack || error.message}`);
    }
  }
  process.exit(0);
}

if (require.main === module) main();

module.exports = {
  buildContext,
  buildEvent,
  canonicalJson,
  delegationFrom,
  detectSignals,
  inferTaskType,
  loopScopeFrom,
  mayRequireActionContract,
  shouldCapture,
  preview,
  redact,
  requiredRules,
  requiredSkills,
  ensureToolActionContract,
  requiresActionContract,
  run,
  threadIdFrom,
};
