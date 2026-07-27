#!/usr/bin/env node
/**
 * Regression tests for harness failure modes found during the audit.
 *
 * These are intentionally behavior-focused:
 * - rules must be loaded deterministically, not by agent self-memory
 * - stale gate state must not unlock unrelated future work
 * - cleanup commands must not count as functional verification
 * - workflow evidence checks must not be delegated to agent self-report
 * - context compression must preserve hard constraints
 * - persistent prompts must keep authorization, evidence, scope, and test integrity explicit
 */

'use strict';

const { HARNESS_ROOT } = require('../lib/harness-root.cjs');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  collectHookEntries,
  validateHookScripts,
} = require('../lib/hook-registry.cjs');

const HOME = HARNESS_ROOT;

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function runNode(scriptPath, stdin, env = {}) {
  return spawnSync('node', [scriptPath], {
    input: stdin || '',
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
    env: { ...process.env, ...env },
  });
}

function withFileBackup(filePath, fn) {
  const existed = fs.existsSync(filePath);
  const original = existed ? fs.readFileSync(filePath) : null;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    return fn();
  } finally {
    if (existed) {
      fs.writeFileSync(filePath, original);
    } else {
      try { fs.unlinkSync(filePath); } catch {}
    }
  }
}

test('rule loader scopes gates to new assets while preserving HDL/Python file rules', () => {
  const loader = require(path.join(HOME, 'engine/scripts/rule-loader.cjs'));
  loader.invalidateRuleIndex();

  const filesFor = (result) => new Set([...(result.matches || []), ...(result.allMatches || [])].map(item => (
    typeof item === 'string' ? item.replace(/\[.*$/, '') : item.file
  )));

  const hdl = loader.evaluate('review existing RTL module', { openFiles: ['src/top.sv'] });
  assert(hdl, 'HDL evaluation returned no rules');
  assert(hdl.mode === 'capsule', `rule loader default mode should be capsule, got ${hdl.mode}`);
  assert(!hdl.ruleContents, 'rule loader injected full ruleContents by default');
  assert(typeof hdl.capsule === 'string' && hdl.capsule.length <= 1800, 'rule capsule missing or too large');
  const hdlFiles = filesFor(hdl);
  assert(hdlFiles.has('00-core.md'), '00-core.md was not loaded for HDL work');
  assert(hdlFiles.has('01-hdl.md'), '01-hdl.md was not loaded for .sv work');
  assert(!hdlFiles.has('03-gates.md'), '03-gates.md should not load for read-only HDL review');

  const newHdl = loader.evaluate('create a new module and verification plan', { openFiles: ['src/new_top.sv'] });
  assert(newHdl, 'new HDL evaluation returned no rules');
  const newHdlFiles = filesFor(newHdl);
  assert(newHdlFiles.has('00-core.md'), '00-core.md was not loaded for new HDL work');
  assert(newHdlFiles.has('01-hdl.md'), '01-hdl.md was not loaded for new .sv work');
  assert(newHdlFiles.has('03-gates.md'), '03-gates.md was not loaded for new HDL work');

  const py = loader.evaluate('modify existing code', { openFiles: ['tools/analyze.py'] });
  assert(py, 'Python evaluation returned no rules');
  const pyFiles = filesFor(py);
  assert(pyFiles.has('00-core.md'), '00-core.md was not loaded for Python work');
  assert(pyFiles.has('02-python.md'), '02-python.md was not loaded for .py work');
  assert(!pyFiles.has('03-gates.md'), '03-gates.md should not load for an existing Python edit');

  const newPy = loader.evaluate('create a new code file and verification plan', { openFiles: ['tools/new_parser.py'] });
  assert(newPy, 'new Python evaluation returned no rules');
  const newPyFiles = filesFor(newPy);
  assert(newPyFiles.has('00-core.md'), '00-core.md was not loaded for new Python work');
  assert(newPyFiles.has('02-python.md'), '02-python.md was not loaded for new .py work');
  assert(newPyFiles.has('03-gates.md'), '03-gates.md was not loaded for new Python work');
});

test('persistent prompts share a scoped evidence-driven contract with a Claude delta', () => {
  const agents = fs.readFileSync(path.join(HOME, 'AGENTS.md'), 'utf8').replace(/\r\n/g, '\n');
  const claude = fs.readFileSync(path.join(HOME, 'CLAUDE.md'), 'utf8').replace(/\r\n/g, '\n');
  const core = fs.readFileSync(path.join(HOME, 'docs/rules/00-core.md'), 'utf8');
  const gates = fs.readFileSync(path.join(HOME, 'docs/rules/03-gates.md'), 'utf8');

  const normalizedAgents = agents.replace(/^# Codex 项目指导/m, '# 共享项目指导').trim();
  const claudeCommon = claude.split('\n## Claude 模型校准\n')[0]
    .replace(/^# Claude Code 项目指导/m, '# 共享项目指导')
    .trim();
  const stopSection = (agents.split('\n## 停止规则\n')[1] || '').split('\n## ')[0];
  const stopBullets = stopSection.match(/^- /gm) || [];

  assert(normalizedAgents === claudeCommon, 'Codex and Claude common guidance drifted');
  assert(!agents.includes('## 目标与完成标准'), 'duplicated completion guidance was not removed');
  assert(!agents.includes('## 协作与工具沟通'), 'duplicated collaboration guidance was not removed');
  assert(agents.includes('透明度账本'), 'repository-specific transparency ledger guidance was lost');
  assert(stopBullets.length === 1, `stop rules must contain exactly one bullet, found ${stopBullets.length}`);
  assert(stopSection.includes('同一方法连续失败两次后改变方法'), 'two-failure method-change stop rule missing');
  assert(agents.includes('明确请求“提交、推送、发布、发送”即授权'), 'explicit external action authorization missing');
  assert(agents.includes('无需重复确认'), 'prompt may ask twice for already explicit authorization');
  assert(agents.includes('先读取或验证再作结论'), 'evidence-before-claims guidance missing');
  assert(agents.includes('不顺带重构、增加抽象、扩展功能'), 'anti-overengineering guidance missing');
  assert(agents.includes('普通任务不创建进度文件'), 'long-task state is not scoped away from simple work');
  assert(claude.includes('## Claude 模型校准'), 'Claude-specific calibration layer missing');
  assert(claude.includes('默认直接完成简单、单文件或强顺序任务'), 'Claude subagent overuse guard missing');
  assert(core.includes('不重复授权、沟通、验证和停止规则'), '00-core still duplicates the persistent contract');
  assert(gates.includes('不得仅为制造通过而削弱、删除或跳过测试'), 'test-integrity rule missing');
});

test('PostToolUse observers share one local-runner batch while cross-link stays standalone', () => {
  const settingsFile = path.join(HOME, 'settings.json');
  const entries = collectHookEntries({ files: [settingsFile] })
    .filter(entry => entry.point === 'PostToolUse' && entry.matcher === '*');
  const batches = entries.filter(entry => entry.command.includes('local-runner.cjs --batch'));
  const observers = [
    '../../hooks/learning/signal-collector.cjs',
    '../../hooks/learning/skill-tracker-hook.cjs',
    '../../hooks/learning/cost-tracker-hook.cjs',
    'agent-transparency-ledger.cjs',
  ];

  assert(batches.length === 1, `expected one PostToolUse observer batch, found ${batches.length}`);
  for (const observer of observers) {
    assert(batches[0].command.includes(observer), `observer missing from batch: ${observer}`);
  }
  assert(batches[0].command.includes('drift_stuck'), 'signal collector batch argument was lost');
  const standaloneObservers = entries.filter(entry =>
    !entry.command.includes('--batch') && observers.some(observer => entry.command.includes(path.basename(observer)))
  );
  assert(standaloneObservers.length === 0, `observer still registered standalone: ${standaloneObservers[0]?.command}`);
  assert(entries.some(entry => entry.command.includes('cross-link-memory.cjs') && !entry.command.includes('--batch')),
    'cross-link-memory must remain a standalone PostToolUse hook');

  const missing = validateHookScripts({ files: [settingsFile] }).missing
    .filter(record => record.command === batches[0].command);
  assert(missing.length === 0, `observer batch has missing scripts: ${missing.map(item => item.source).join(', ')}`);
});

// 契约变更 (刻意): 这两道门禁已从 exit 2 硬阻断降级为结构化 Hook advisory。
// 它们唯一的放行条件是模型自己写一份 status:"completed" 的 JSON(无 schema、
// 无有效期、无写保护), 阻断只会诱导伪造门禁记录, 并对临时脚本大量误报。
// 但**作用域隔离本身仍必须成立**: 属于别的项目的 completed 状态不得被当作
// 本项目已澄清 —— 因此这里断言"仍然识别为未完成并通过 additionalContext 提示", 而不是
// 断言退出码。真正的硬门禁见 hdl-coding-dag-workflow.js 的 Phase 4.5
// (校验 check_results/<mod>.json 真实存在且 status===PASS)。
test('requirements gate does not honor completed state scoped to another project', () => {
  const stateFile = path.join(HOME, 'var/gates/requirements-gate.json');
  const guard = path.join(HOME, 'engine/scripts/hooks/requirements-gate-guard.cjs');
  const target = path.join(os.tmpdir(), `harness-unrelated-${Date.now()}`, 'new_module.py');

  withFileBackup(stateFile, () => {
    fs.writeFileSync(stateFile, JSON.stringify({
      status: 'completed',
      task: 'old unrelated FPGA task',
      projectRoot: path.join(os.tmpdir(), 'old-project'),
      completedAt: '2026-01-01T00:00:00.000Z',
    }, null, 2));

    const payload = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: target },
    });
    const r = runNode(guard, payload);
    assert(r.status === 0, `advisory gate must not block, exit=${r.status}`);
    const hookOutput = JSON.parse(r.stdout);
    const advisory = JSON.parse(hookOutput.hookSpecificOutput.additionalContext);
    assert(advisory.source === 'requirements-gate' && advisory.status === 'warning' && advisory.blocking === false,
      `stale cross-project state was silently honored (no advisory emitted), stdout=${r.stdout.slice(0, 200)}`);
  });
});

test('verification quality gate does not honor completed state scoped to another project', () => {
  const stateFile = path.join(HOME, 'var/gates/verification-quality.json');
  const guard = path.join(HOME, 'engine/scripts/hooks/verification-quality-guard.cjs');
  const target = path.join(os.tmpdir(), `harness-unrelated-${Date.now()}`, 'tb_new_module.sv');

  withFileBackup(stateFile, () => {
    fs.writeFileSync(stateFile, JSON.stringify({
      status: 'completed',
      module: 'old_module',
      projectRoot: path.join(os.tmpdir(), 'old-project'),
      completedAt: '2026-01-01T00:00:00.000Z',
    }, null, 2));

    const payload = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: target },
    });
    const r = runNode(guard, payload);
    assert(r.status === 0, `advisory gate must not block, exit=${r.status}`);
    const hookOutput = JSON.parse(r.stdout);
    const advisory = JSON.parse(hookOutput.hookSpecificOutput.additionalContext);
    assert(advisory.source === 'verification-quality' && advisory.status === 'warning' && advisory.blocking === false,
      `stale cross-project state was silently honored (no advisory emitted), stdout=${r.stdout.slice(0, 200)}`);
  });
});

test('verification gate does not treat make clean as functional verification', () => {
  const stateFile = path.join(HOME, 'var/verify-gate.json');
  const gate = path.join(HOME, 'engine/scripts/hooks/verification-gate.cjs');

  withFileBackup(stateFile, () => {
    fs.writeFileSync(stateFile, JSON.stringify({
      edited: true,
      verified: false,
      editCount: 1,
      lastEditTime: new Date().toISOString(),
    }, null, 2));

    const payload = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'make clean' },
    });
    const r = runNode(gate, payload);
    const state = readJson(stateFile, {});
    assert(r.status === 2, `make clean should be blocked while verification is pending, exit=${r.status}`);
    assert(state.edited === true && state.verified !== true, 'make clean cleared the pending verification state');
  });
});

test('verification gate only clears after successful PostToolUse evidence', () => {
  const stateFile = path.join(HOME, 'var/verify-gate.json');
  const ledgerFile = path.join(HOME, 'var/verification-ledger.json');
  const gate = path.join(HOME, 'engine/scripts/hooks/verification-gate.cjs');

  withFileBackup(stateFile, () => withFileBackup(ledgerFile, () => {
    fs.writeFileSync(stateFile, JSON.stringify({
      edited: true,
      verified: false,
      editCount: 1,
      lastEditTime: new Date().toISOString(),
    }, null, 2));

    const pre = runNode(gate, JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'pytest tests' },
    }));
    assert(pre.status === 0, `verification command should be allowed to run, exit=${pre.status}`);
    let state = readJson(stateFile, {});
    assert(state.edited === true && state.verified !== true, 'PreToolUse cleared verification before execution evidence existed');

    const postFail = runNode(gate, JSON.stringify({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'pytest tests' },
      tool_response: { status: 0, stdout: 'RESULT: FAIL', stderr: '' },
    }));
    assert(postFail.status === 0, `failed post evidence should not crash hook, exit=${postFail.status}`);
    state = readJson(stateFile, {});
    assert(state.edited === true && state.verified !== true, 'failed verification log cleared pending state');

    const postPass = runNode(gate, JSON.stringify({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'pytest tests' },
      tool_response: { status: 0, stdout: '2 passed', stderr: '' },
    }));
    assert(postPass.status === 0, `passing post evidence failed, exit=${postPass.status}`);
    state = readJson(stateFile, {});
    assert(state.edited === false && state.verified === true, 'passing PostToolUse evidence did not clear pending state');
  }));
});

test('verification gate allows read-only echo chains but blocks echo redirection', () => {
  const gate = path.join(HOME, 'engine/scripts/hooks/verification-gate.cjs');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-echo-'));
  const env = {
    CLAUDE_VERIFY_GATE_STATE_FILE: path.join(tmpRoot, 'verify-gate.json'),
    CLAUDE_VERIFICATION_LEDGER_FILE: path.join(tmpRoot, 'verification-ledger.json'),
  };
  const sessionId = 'echo-safety-session';

  runNode(gate, JSON.stringify({
    hook_event_name: 'PostToolUse',
    tool_name: 'Write',
    cwd: tmpRoot,
    session_id: sessionId,
    tool_input: { file_path: path.join(tmpRoot, 'dut.sv') },
  }), env);

  const readOnly = runNode(gate, JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    cwd: tmpRoot,
    session_id: sessionId,
    tool_input: { command: 'git log -1 && echo inspection-complete && ls' },
  }), env);
  assert(readOnly.status === 0, `read-only echo chain was blocked, exit=${readOnly.status}`);

  const redirected = runNode(gate, JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    cwd: tmpRoot,
    session_id: sessionId,
    tool_input: { command: 'echo payload > generated.sv' },
  }), env);
  assert(redirected.status === 2, `echo redirection escaped the gate, exit=${redirected.status}`);
});

test('verification pending is session-scoped and expires by TTL', () => {
  const gate = path.join(HOME, 'engine/scripts/hooks/verification-gate.cjs');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-session-'));
  const stateFile = path.join(tmpRoot, 'verify-gate.json');
  const env = {
    CLAUDE_VERIFY_GATE_STATE_FILE: stateFile,
    CLAUDE_VERIFICATION_LEDGER_FILE: path.join(tmpRoot, 'verification-ledger.json'),
    CLAUDE_VERIFY_GATE_TTL_MS: '60000',
  };

  runNode(gate, JSON.stringify({
    hook_event_name: 'PostToolUse',
    tool_name: 'Write',
    cwd: tmpRoot,
    session_id: 'session-a',
    tool_input: { file_path: path.join(tmpRoot, 'dut.sv') },
  }), env);

  const otherSession = runNode(gate, JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    cwd: tmpRoot,
    session_id: 'session-b',
    tool_input: { command: 'node build.cjs' },
  }), env);
  assert(otherSession.status === 0, `session-b inherited session-a pending state, exit=${otherSession.status}`);

  const sameSession = runNode(gate, JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    cwd: tmpRoot,
    session_id: 'session-a',
    tool_input: { command: 'node build.cjs' },
  }), env);
  assert(sameSession.status === 2, `unexpired pending state did not block its owner session, exit=${sameSession.status}`);

  const state = readJson(stateFile, {});
  const entry = Object.values(state.pending || {})[0];
  assert(entry, 'pending entry was not recorded');
  entry.lastEditTime = '2000-01-01T00:00:00.000Z';
  entry.expiresAt = '2000-01-01T00:01:00.000Z';
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');

  const expired = runNode(gate, JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    cwd: tmpRoot,
    session_id: 'session-a',
    tool_input: { command: 'node build.cjs' },
  }), env);
  assert(expired.status === 0, `expired pending state still blocked its owner session, exit=${expired.status}`);
});

test('verification gate cites the rule file without copying stale rule text', () => {
  const gate = fs.readFileSync(
    path.join(HOME, 'engine/scripts/hooks/verification-gate.cjs'),
    'utf8'
  );
  assert(gate.includes('docs/rules/00-core.md'), 'verification gate no longer cites docs/rules/00-core.md');
  assert(!gate.includes('rules/00-core.md 验证闭环铁律'), 'verification gate still labels stale text as an iron rule');
  assert(!gate.includes('改代码后必须跑对应的验证，不验证不提交'), 'verification gate still copies removed rule text');
});

test('context compression preserves constitution and dynamic rules', () => {
  const budget = require(path.join(HOME, 'engine/scripts/agent-context-budget.cjs'));
  const prompt = [
    '## Agent Constitution',
    'Hard rule: obey user constraints before efficiency.',
    '',
    '## Dynamic behaviour rules',
    'Ask for clarification when project requirements are ambiguous.',
    '',
    '## Memory Context (Auto-Loaded)',
    'x'.repeat(26000),
    '',
    '## AVAILABLE_SKILLS',
    'y'.repeat(6000),
  ].join('\n');

  const result = budget.compressPrompt(prompt, 'developer', { tier: 'normal' });
  assert(result.prompt.includes('## Agent Constitution'), 'constitution was removed during compression');
  assert(result.prompt.includes('## Dynamic behaviour rules'), 'dynamic behaviour rules were removed during compression');
});

test('workflow evidence gates are not based on agent self-report or catch-and-continue', () => {
  const workflowPath = path.join(HOME, 'workflows/hdl-coding-dag-workflow.js');
  const workflow = fs.readFileSync(workflowPath, 'utf8');

  assert(!workflow.includes('Does file exist:'), 'workflow still delegates file existence checks to agent self-report');
  assert(!workflow.includes('Read file:'), 'workflow still delegates file reads to agent self-report');
  assert(!workflow.includes('List .json files'), 'workflow still delegates directory listing to agent self-report');
  assert(!workflow.includes('06_doct'), 'workflow still contains the drifted 06_doct path');
  assert(
    !/catch\s*\(\s*e\s*\)\s*\{\s*results\s*\[\s*name\s*\]\s*=\s*\{\s*status:\s*'error'/s.test(workflow),
    'DAG executor still catches node errors and continues'
  );
});

function main() {
  let passed = 0;
  let failed = 0;

  console.log('\nHarness painpoint regression tests\n');
  for (const t of tests) {
    process.stdout.write(`  ${t.name.padEnd(82)} `);
    try {
      t.fn();
      passed += 1;
      console.log('PASS');
    } catch (e) {
      failed += 1;
      console.log('FAIL');
      console.log(`    ${e.message}`);
    }
  }

  console.log(`\nSummary: ${passed}/${tests.length} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
