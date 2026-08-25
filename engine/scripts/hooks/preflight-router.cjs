#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SHELL_TOOLS = new Set(['bash', 'powershell']);
const WRITE_TOOLS = new Set(['edit', 'write', 'multiedit']);
const ACTION_CONTRACT_TOOLS = new Set(['Bash', 'Edit', 'Write', 'MultiEdit', 'Agent', 'Task', 'Workflow']);
const ALWAYS_READ_ONLY_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'TodoRead', 'AskUserQuestion',
]);

const CODE_EXTENSIONS = new Set([
  '.c', '.cc', '.cjs', '.cpp', '.go', '.h', '.hpp', '.js', '.mjs', '.py', '.rs', '.sv', '.ts', '.tsx', '.v', '.vhd', '.vh',
]);

function readPayload() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return {};
  }
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid PreToolUse JSON: ${error.message}`);
  }
}

function toolInputFrom(payload) {
  return payload?.tool_input || payload?.tool?.input || payload?.input || payload?.arguments || {};
}

function runtimeFrom(payload) {
  const input = toolInputFrom(payload);
  const toolName = String(payload?.tool_name || payload?.tool?.name || payload?.name || '');
  const cwd = path.resolve(String(payload?.cwd || process.cwd()));
  const fileValue = input.file_path || input.path || payload?.file_path || '';
  const hasDirectContent = Object.prototype.hasOwnProperty.call(input, 'content')
    || Object.prototype.hasOwnProperty.call(payload || {}, 'content');
  return {
    payload,
    eventName: String(payload?.hook_event_name || payload?.event || 'PreToolUse'),
    toolName,
    toolKey: toolName.toLowerCase(),
    input,
    command: String(input.command || payload?.command || '').trim(),
    cwd,
    filePath: fileValue ? path.resolve(cwd, String(fileValue)) : '',
    content: hasDirectContent ? String(input.content ?? payload?.content ?? '') : undefined,
    commits: [],
    diagnostics: [],
    advisories: [],
    additionalContexts: [],
  };
}

function changedTextFromRuntime(runtime) {
  const edits = Array.isArray(runtime.input?.edits) ? runtime.input.edits : [];
  return [
    runtime.content,
    runtime.input?.old_string,
    runtime.input?.new_string,
    runtime.input?.oldString,
    runtime.input?.newString,
    ...edits.flatMap(edit => [edit?.old_string, edit?.new_string, edit?.oldString, edit?.newString]),
  ].filter(value => value !== undefined && value !== null).join('\n');
}

function isReadOnlyShellCommand(command) {
  const value = String(command || '').trim();
  if (!value) return true;
  return [
    /^git(?:\.exe)?\s+(?:status|diff|log|show|rev-parse|branch)(?:\s|$)/i,
    /^(?:rg|grep|findstr|Get-Content|Select-String|Test-Path|Get-Item|Get-ChildItem|ls|dir|pwd)(?:\s|$)/i,
    /\b(?:pytest|py\.test|xsim|vsim|vvp|iverilog|cargo\s+test|go\s+test|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test)\b/i,
    /\bnode(?:\.exe)?\s+[^\n]*(?:test-hooks|contract|regression|--check)\b/i,
  ].some(pattern => pattern.test(value));
}

function riskFactsFromRuntime(runtime, opts = {}) {
  const fileExists = opts.fileExists || fs.existsSync;
  const signals = runtime.input?.risk_signals || runtime.payload?.risk_signals || {};
  const isWrite = WRITE_TOOLS.has(runtime.toolKey);
  const isShell = SHELL_TOOLS.has(runtime.toolKey);
  const command = String(runtime.command || '');
  const readOnly = ALWAYS_READ_ONLY_TOOLS.has(runtime.toolName)
    || (isShell && isReadOnlyShellCommand(command));
  const changedText = changedTextFromRuntime(runtime);
  const semanticText = `${runtime.filePath}\n${changedText}`;
  const destructive = Boolean(signals.destructive) || [
    /\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f)/i,
    /\brm\s+-[a-z]*r[a-z]*f|\bRemove-Item\b[^\n]*(?:-Recurse|-Force)/i,
    /\b(?:drop|truncate)\s+(?:database|table)\b/i,
    /\bformat\s+[a-z]:/i,
  ].some(pattern => pattern.test(command));
  const releaseAction = Boolean(signals.releaseAction) || [
    /\bgit\s+(?:commit|push)\b/i,
    /\b(?:npm|pnpm|yarn)\s+publish\b/i,
    /\b(?:deploy|release)\b/i,
  ].some(pattern => pattern.test(command));
  const ext = path.extname(runtime.filePath || '').toLowerCase();
  const existingFile = Boolean(runtime.filePath) && fileExists(runtime.filePath);
  const newModule = Boolean(signals.newModule)
    || (isWrite && Boolean(runtime.filePath) && CODE_EXTENSIONS.has(ext) && !existingFile);
  const interfaceChange = Boolean(signals.interfaceChange) || [
    /\bmodule\.exports\b|\bexports\.[A-Za-z_$]/,
    /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type)\b/,
    /\b(?:schemaVersion|publicApi|apiVersion)\b/,
    /\b(?:input|output|inout)\s+(?:wire|logic|reg|signed|unsigned|\[)/i,
  ].some(pattern => pattern.test(changedText));
  const clockResetCdcChange = Boolean(signals.clockResetCdcChange)
    || /\b(?:clock|clk|reset|rst|cdc|async_fifo|synchroni[sz]er)\b/i.test(changedText);
  const goldenChange = Boolean(signals.goldenChange)
    || /[/\\](?:golden|models?)[/\\]/i.test(runtime.filePath)
    || /\bgolden\s+model\b/i.test(changedText);
  const sharedCoreChange = Boolean(signals.sharedCoreChange)
    || /[/\\](?:lib|shared|core|cbb)[/\\]/i.test(runtime.filePath);
  const repeatedFailure = Boolean(signals.repeatedFailure)
    || Number(runtime.payload?.failure_count || runtime.payload?.failureCount || 0) >= 2;
  return {
    toolName: runtime.toolName,
    readOnly,
    mutating: isWrite || (isShell && !readOnly),
    existingFile,
    internalChange: isWrite && existingFile && !interfaceChange && !clockResetCdcChange && !goldenChange,
    newModule,
    interfaceChange,
    clockResetCdcChange,
    goldenChange,
    sharedCoreChange,
    repeatedFailure,
    destructive,
    releaseAction,
    protectedTarget: Boolean(signals.protectedTarget),
    crossProject: Boolean(signals.crossProject),
    graphStale: Boolean(signals.graphStale || opts.graphStale),
    uncertain: Boolean(signals.uncertain),
    agentRiskLevel: runtime.input?.risk_level || runtime.payload?.risk_level,
  };
}

function evaluateRiskPolicy(runtime, opts = {}) {
  const policy = require('../lib/risk-policy.cjs');
  const env = opts.env || process.env;
  const mode = policy.riskPolicyMode(env);
  if (mode === 'off') {
    const assessment = policy.classifyRisk({ toolName: runtime.toolName, readOnly: true });
    return { ...policy.applyRiskPolicy(assessment, { mode }), assessment };
  }

  const facts = riskFactsFromRuntime(runtime, opts);
  let assessment = policy.classifyRisk(facts);
  if (assessment.effectiveRiskLevel !== 'R0') {
    try {
      const stateApi = opts.stateApi || require('../lib/verification-state.cjs');
      const readVerificationState = opts.readVerificationState || stateApi.readVerificationState;
      const riskForPayload = opts.riskForPayload || stateApi.riskForPayload;
      const active = riskForPayload(readVerificationState(), runtime.payload);
      const persistedRiskLevel = active.reduce(
        (level, entry) => policy.maxRiskLevel(level, entry.effectiveRiskLevel),
        'R0',
      );
      assessment = policy.classifyRisk({ ...facts, persistedRiskLevel });
    } catch {
      assessment = policy.classifyRisk({ ...facts, uncertain: true });
    }
  }

  let authorization = { requested: false, allowed: false, errors: [] };
  if (mode === 'enforce' && assessment.effectiveRiskLevel === 'R3') {
    const evaluateBypass = opts.evaluateBypass
      || require('../lib/gate-bypass.cjs').evaluateGuardBypass;
    authorization = evaluateBypass({
      gateId: 'risk-policy.cjs',
      payload: runtime.payload,
      context: runtime.context,
      env,
      actionHash: policy.riskActionHash({
        toolName: runtime.toolName,
        cwd: runtime.cwd,
        filePath: runtime.filePath,
        command: runtime.command,
        input: runtime.input,
      }),
      requireActionBinding: true,
      oneShot: true,
    });
  }
  return {
    ...policy.applyRiskPolicy(assessment, { mode, authorized: authorization.allowed }),
    assessment,
    authorization,
  };
}

function normalizedResult(source, value) {
  if (!value || typeof value !== 'object') return { source, decision: 'allow' };
  const decision = ['allow', 'warn', 'block'].includes(value.decision) ? value.decision : 'allow';
  return { ...value, source, decision };
}

function recordPromotedAttribution(runtime, gateResult, deps = {}) {
  let wDb;
  try {
    const openAttributionDb = deps.openAttributionDb || require('../../sqlite/index.cjs').openDb;
    const memoryAttribution = deps.memoryAttribution
      || require('../../sqlite/store-memory-attribution.cjs');
    wDb = openAttributionDb({});
    return memoryAttribution.observePromotedHarnessGateResult(
      runtime.payload,
      gateResult,
      { db: wDb.db },
    );
  } catch (error) {
    runtime.diagnostics.push({
      source: 'memory-attribution',
      message: `promoted rule attribution dropped: ${error.stack || error.message}`,
    });
    return { recorded: 0, rejected: true, reason: 'attribution-write-failed' };
  } finally {
    try { wDb?.close(); } catch { /* blocking decision must survive cleanup failure */ }
  }
}

function appendResult(runtime, result) {
  const diagnostics = Array.isArray(result.diagnostics)
    ? result.diagnostics
    : result.diagnostics ? [result.diagnostics] : [];
  for (const item of diagnostics) {
    let message;
    if (typeof item === 'string') message = item;
    else if (item instanceof Error) message = item.stack || item.message;
    else if (item && typeof item === 'object') message = item.message || JSON.stringify(item);
    else message = String(item);
    runtime.diagnostics.push({ source: result.source, decision: result.decision, message });
  }
  const advisories = Array.isArray(result.advisories)
    ? result.advisories
    : result.advisory ? [result.advisory] : [];
  for (const advisory of advisories) {
    runtime.advisories.push(typeof advisory === 'string'
      ? { source: result.source, message: advisory }
      : { source: result.source, ...advisory });
  }
  if (result.decision === 'warn' && advisories.length === 0) {
    runtime.advisories.push({
      source: result.source,
      message: diagnostics.map((entry) => String(entry)).join('; ') || 'advisory warning',
    });
  }
  if (typeof result.commit === 'function') {
    runtime.commits.push({
      source: result.source,
      run: result.commit,
      critical: result.commitCritical !== false,
    });
  }
}

async function runGate(runtime, spec) {
  try {
    const moduleValue = spec.load();
    const evaluate = moduleValue?.evaluate;
    if (typeof evaluate !== 'function') throw new Error('evaluate(payload, runtime) export is missing');
    const result = normalizedResult(spec.source, await evaluate(runtime.payload, runtime));
    appendResult(runtime, result);
    return result;
  } catch (error) {
    const result = {
      source: spec.source,
      decision: spec.failClosed ? 'block' : 'warn',
      diagnostics: [`internal error: ${error.stack || error.message}`],
    };
    appendResult(runtime, result);
    return result;
  }
}

function shellSpecs(command) {
  const { gitSubcommand } = require('./verification-gate.cjs');
  const gitAction = gitSubcommand(command);
  const specs = [
    { source: 'bash-safety', failClosed: true, load: () => require('./bash-safety-guard.cjs') },
    { source: 'fix-in-place', failClosed: false, load: () => require('../../hooks/safety/fix-in-place-guard.cjs') },
    { source: 'verification-gate', failClosed: false, load: () => require('./verification-gate.cjs') },
  ];
  if (gitAction === 'commit') {
    // diff-size 在 commit 时只跑范围溢出检查 —— 噪声要在进历史之前说, 等到 push
    // 才提示已经晚了。规模阈值仍只在 push 时按分支累计判定。
    specs.push(
      { source: 'diff-size', failClosed: false, load: () => require('./diff-size-gate.js') },
      { source: 'resource-budget', failClosed: false, load: () => require('./resource-budget-gate.js') },
    );
  } else if (gitAction === 'push') {
    specs.push(
      { source: 'diff-size', failClosed: false, load: () => require('./diff-size-gate.js') },
      { source: 'resource-budget', failClosed: false, load: () => require('./resource-budget-gate.js') },
    );
  }
  return specs;
}

function writeSpecs(runtime = {}) {
  const specs = [
    { source: 'project-directory', failClosed: true, load: () => require('./project-directory-guard.cjs') },
    { source: 'repair-content', failClosed: true, load: () => require('./repair-content-gate.cjs') },
    { source: 'file-protection', failClosed: true, load: () => require('./file-protection-guard.cjs') },
    { source: 'fix-in-place', failClosed: false, load: () => require('../../hooks/safety/fix-in-place-guard.cjs') },
  ];
  const filePath = String(runtime.filePath || '').trim();
  const ext = path.extname(filePath).toLowerCase();
  const isNewFile = Boolean(filePath) && !fs.existsSync(filePath);
  const isRtl = ext === '.sv' || ext === '.v';
  const isCode = ['.sv', '.v', '.vh', '.py', '.c', '.cpp', '.h', '.vhd'].includes(ext);
  const isTest = [
    /[/\\]tb_[\w-]+\.(sv|v|vhd)$/i,
    /[\w-]+_tb\.(sv|v|vhd)$/i,
    /[/\\]test_[\w-]+\.py$/i,
    /[\w-]+_test\.(py|cpp)$/i,
    /[/\\]testbench[\w-]*\.(sv|v|vhd)$/i,
    /[/\\]sim[/\\].+\.(sv|v)$/i,
    /[/\\]tb[/\\].+\.(sv|v)$/i,
  ].some((pattern) => pattern.test(filePath));
  const excludedFromRequirements = isTest
    || /[/\\](?:golden|matlab)[/\\]/i.test(filePath);

  if (isRtl) {
    specs.push({ source: 'hdl-gate', failClosed: false, load: () => require('./hdl-gate.cjs') });
  }
  if (isNewFile && isCode && !excludedFromRequirements
      && (runtime.toolKey === 'write' || runtime.toolKey === 'edit')) {
    specs.push({ source: 'requirements-gate', failClosed: false, load: () => require('./requirements-gate-guard.cjs') });
  }
  if (isNewFile && isTest && runtime.toolKey === 'write') {
    specs.push({ source: 'verification-quality', failClosed: false, load: () => require('./verification-quality-guard.cjs') });
  }
  if (isRtl) {
    specs.push({ source: 'rtl-semantic-oracle', failClosed: false, load: () => require('./rtl-semantic-oracle.cjs') });
  }
  return specs;
}

function compactAdvisory(advisory) {
  if (typeof advisory === 'string') return advisory.trim();
  if (!advisory || typeof advisory !== 'object') return '';
  const source = String(advisory.source || 'preflight').trim();
  const summary = String(
    advisory.message
      || advisory.summary
      || advisory.reason
      || advisory.code
      || advisory.status
      || 'review required',
  ).trim();
  const targetValue = String(advisory.target || '').trim();
  const target = targetValue ? path.basename(targetValue) : '';
  return `[${source}] ${summary}${target ? ` (target: ${target})` : ''}`;
}

function formatAdditionalContext(runtime) {
  const blocks = (runtime.additionalContexts || [])
    .map((entry) => String(entry?.message || '').trim())
    .filter(Boolean);
  if (runtime.advisories.length > 0) {
    blocks.push(...runtime.advisories.map(compactAdvisory).filter(Boolean));
  }
  return require('./prompt-context.cjs').mergeContextBlocks(blocks, 320);
}

function watchdogResult(payload, result) {
  const blocking = result.status === 'bypass_reason_required'
    || (result.status === 'frozen_escalation_required'
      && result.mode === 'enforce'
      && String(payload?.hook_event_name || '') !== 'Stop');
  if (blocking) {
    return {
      source: 'progress-watchdog',
      decision: 'block',
      diagnostics: [result.session?.freezeReason || result.status],
    };
  }
  if (['warning', 'frozen_notice', 'frozen_escalation_required', 'bypassed'].includes(result.status)) {
    return {
      source: 'progress-watchdog',
      decision: 'warn',
      advisories: [{ status: result.status, blocking: false }],
    };
  }
  return { source: 'progress-watchdog', decision: 'allow' };
}

async function runCommon(runtime, opts = {}) {
  const noPersist = process.env.CLAUDE_HARNESS_NO_PERSIST === '1'
    || process.env.CLAUDE_HARNESS_VERIFY_READONLY === '1';
  let commonResult = { source: 'common', decision: 'allow' };

  // Preserve the security/audit order for controlled actions: write one fresh
  // contract, validate that exact payload, and only then inspect watchdog state.
  // Read-only and ordinary low-risk calls still skip the heavy ledger path.
  if (!noPersist && process.env.CLAUDE_TRANSPARENCY_LEDGER_DISABLED !== '1'
      && ACTION_CONTRACT_TOOLS.has(runtime.toolName)) {
    const ledger = require('./agent-transparency-ledger.cjs');
    if (ledger.mayRequireActionContract(runtime.payload)) {
      let context;
      try {
        context = ledger.buildContext(runtime.payload);
        runtime.context = context;
      } catch (error) {
        const result = {
          source: 'tool-action-contract',
          decision: 'warn',
          diagnostics: [`context build failed: ${error.stack || error.message}`],
        };
        appendResult(runtime, result);
        commonResult = result;
      }

      if (context) {
        try {
          const written = ledger.run(runtime.payload, { context });
          const contractGate = require('./tool-action-contract-gate.cjs');
          const result = normalizedResult('tool-action-contract', contractGate.evaluate(runtime.payload, {
            context,
            contract: written.artifacts?.toolActionContract,
          }));
          appendResult(runtime, result);
          commonResult = result;
          if (result.decision === 'block') return result;
        } catch (error) {
          const result = {
            source: 'tool-action-contract',
            decision: context.loopScope?.status === 'blocked' ? 'block' : 'warn',
            diagnostics: [`ledger write failed: ${error.stack || error.message}`],
          };
          appendResult(runtime, result);
          commonResult = result;
          if (result.decision === 'block') return result;
        }
      }
    }
  }

  if (!noPersist && !ALWAYS_READ_ONLY_TOOLS.has(runtime.toolName)) {
    const watchdog = require('../../hooks/session/progress-watchdog.cjs');
    if (watchdog.isReadOnlyAction(runtime.payload)) return commonResult;
    try {
      const result = watchdogResult(runtime.payload, watchdog.inspectProgress(runtime.payload, {
        riskLevel: opts.riskLevel,
      }));
      appendResult(runtime, result);
      if (result.decision === 'block') return result;
    } catch (error) {
      appendResult(runtime, {
        source: 'progress-watchdog',
        decision: 'warn',
        diagnostics: [`internal error: ${error.stack || error.message}`],
      });
    }
  }

  return commonResult;
}

async function commitDeferred(runtime) {
  for (const entry of runtime.commits) {
    try {
      await entry.run();
    } catch (error) {
      const result = {
        source: entry.source,
        decision: entry.critical ? 'block' : 'warn',
        diagnostics: [`deferred commit failed: ${error.stack || error.message}`],
      };
      appendResult(runtime, result);
      if (result.decision === 'block') return result;
    }
  }
  return { source: 'deferred-commit', decision: 'allow' };
}

function emit(runtime, decision) {
  if (decision === 'block') {
    for (const item of runtime.diagnostics) {
      process.stderr.write(`[preflight-router:${item.source}] ${item.message}\n`);
    }
    process.stderr.write('[preflight-router] BLOCKED\n');
    process.exitCode = 2;
    return;
  }
  const additionalContext = formatAdditionalContext(runtime);
  if (additionalContext) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: runtime.eventName || 'PreToolUse',
        additionalContext,
      },
    }));
  }
}

async function main() {
  let payload;
  try {
    payload = readPayload();
  } catch (error) {
    process.stderr.write(`[preflight-router] ${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  return require('../lib/hook-latency.cjs').timed(
    'preflight-router',
    String(payload?.hook_event_name || 'PreToolUse'),
    () => mainWithPayload(payload),
  );
}

async function mainWithPayload(payload) {
  const runtime = runtimeFrom(payload);
  const promotedPolicy = await runGate(runtime, {
    source: 'promoted-harness-gate',
    failClosed: true,
    load: () => require('./promoted-harness-gate.cjs'),
  });
  if (promotedPolicy.decision === 'block') {
    recordPromotedAttribution(runtime, promotedPolicy);
    emit(runtime, 'block');
    return;
  }
  const riskPolicy = normalizedResult('risk-policy', evaluateRiskPolicy(runtime));
  appendResult(runtime, riskPolicy);
  if (riskPolicy.decision === 'block') {
    emit(runtime, 'block');
    return;
  }
  const specs = SHELL_TOOLS.has(runtime.toolKey)
    ? shellSpecs(runtime.command)
    : WRITE_TOOLS.has(runtime.toolKey) ? writeSpecs(runtime) : [];

  for (const spec of specs) {
    const result = await runGate(runtime, spec);
    if (result.decision === 'block') {
      emit(runtime, 'block');
      return;
    }
  }

  const common = await runCommon(runtime, {
    riskLevel: riskPolicy.assessment?.effectiveRiskLevel,
  });
  if (common.decision === 'block') {
    emit(runtime, 'block');
    return;
  }
  const committed = await commitDeferred(runtime);
  emit(runtime, committed.decision);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[preflight-router] fatal: ${error.stack || error.message}\n`);
    process.exitCode = 2;
  });
}

module.exports = {
  main,
  runtimeFrom,
  riskFactsFromRuntime,
  isReadOnlyShellCommand,
  evaluateRiskPolicy,
  writeSpecs,
  formatAdditionalContext,
  recordPromotedAttribution,
};
