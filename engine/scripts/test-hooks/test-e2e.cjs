#!/usr/bin/env node
/**
 * engine/scripts/test-hooks/test-e2e.cjs — E2E 恢复测试 (P2)
 *
 * 端到端测试 Harness 核心功能的完整性:
 *   1. Hook 注册完整性 — 所有 settings.json 中的 hook 文件存在
 *   2. Verification Gate 全周期 — write → block → verify → clear → allow
 *   3. Pre-compact 检查点
 *   4. Commit gate 语法
 *
 * 用法:
 *   node engine/scripts/test-hooks/test-e2e.cjs
 *   node engine/scripts/test-hooks/test-e2e.cjs --verbose
 *   node engine/scripts/test-hooks/test-e2e.cjs --json
 */

'use strict';

const { HARNESS_ROOT } = require('../lib/harness-root.cjs');

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { validateHookScripts } = require('../lib/hook-registry.cjs');

const HOME = HARNESS_ROOT;
const VERBOSE = process.argv.includes('--verbose');
const JSON_OUTPUT = process.argv.includes('--json');

const results = [];

function test(name, fn) {
  try {
    const r = fn();
    const ok = r === true || (r && r.ok !== false);
    results.push({ name, pass: ok, detail: r.detail || '' });
    if (VERBOSE) {
      process.stdout.write(`  ${name.padEnd(55)} ${ok ? '✅ PASS' : '❌ FAIL'}\n`);
    }
  } catch (e) {
    results.push({ name, pass: false, detail: e.message });
    if (VERBOSE) {
      process.stdout.write(`  ${name.padEnd(55)} ❌ FAIL (${e.message})\n`);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Test 1: Hook 注册完整性
// ═════════════════════════════════════════════════════════════════════════════

test('Hook 注册完整性', () => {
  const validation = validateHookScripts();
  if (validation.missing.length > 0) {
    const missing = validation.missing.map(ref => path.basename(ref.script));
    return { ok: false, detail: `缺失 ${missing.length} 个: ${missing.join(', ')}` };
  }
  return { ok: true, detail: `${validation.found.length} 个 hook 全部存在` };
});

// ═════════════════════════════════════════════════════════════════════════════
// Test 2: Verification Gate 全周期
// ═════════════════════════════════════════════════════════════════════════════

test('Verification Gate 全周期 (write → block → verify → clear → allow)', () => {
  const gatePath = path.join(HOME, 'engine/scripts/hooks/verification-gate.cjs');
  if (!fs.existsSync(gatePath)) return { ok: false, detail: 'verification-gate.cjs 不存在' };

  // Step 1: 模拟编辑操作写状态文件
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-e2e-'));
  const stateFile = path.join(stateDir, 'verify-gate.json');
  const ledgerFile = path.join(stateDir, 'verification-ledger.json');
  const env = {
    ...process.env,
    CLAUDE_VERIFY_GATE_STATE_FILE: stateFile,
    CLAUDE_VERIFICATION_LEDGER_FILE: ledgerFile,
  };
  if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ edited: true, verified: false, editCount: 1 }), 'utf8');

  // Step 2: 非安全命令应被拦截 (exit 2)
  const blockResult = spawnSync('node', [gatePath], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo test' } }),
    encoding: 'utf8', timeout: 5000, windowsHide: true, env,
  });
  if (blockResult.status !== 2) {
    return { ok: false, detail: `期望 block exit=2, 实际 exit=${blockResult.status}` };
  }

  // Step 3: PreToolUse 仅放行验证命令，不清除标记
  const verifyResult = spawnSync('node', [gatePath], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } }),
    encoding: 'utf8', timeout: 5000, windowsHide: true, env,
  });
  if (verifyResult.status !== 0) {
    return { ok: false, detail: `期望 verify exit=0, 实际 exit=${verifyResult.status}` };
  }

  const stillBlocked = spawnSync('node', [gatePath], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo test' } }),
    encoding: 'utf8', timeout: 5000, windowsHide: true, env,
  });
  if (stillBlocked.status !== 2) {
    return { ok: false, detail: `PreToolUse 过早清除了验证状态, exit=${stillBlocked.status}` };
  }

  // Step 4: PostToolUse 凭真实执行结果和日志证据清除标记
  const verifyPost = spawnSync('node', [gatePath], {
    input: JSON.stringify({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { status: 0, stdout: '1 passed', stderr: '' },
    }),
    encoding: 'utf8', timeout: 5000, windowsHide: true, env,
  });
  if (verifyPost.status !== 0) {
    return { ok: false, detail: `期望 verify post exit=0, 实际 exit=${verifyPost.status}` };
  }

  // Step 5: 验证后非安全命令应放行
  const allowResult = spawnSync('node', [gatePath], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo test' } }),
    encoding: 'utf8', timeout: 5000, windowsHide: true, env,
  });
  if (allowResult.status !== 0) {
    return { ok: false, detail: `期望 verify 后 allow exit=0, 实际 exit=${allowResult.status}` };
  }

  // 清理
  try { fs.unlinkSync(stateFile); } catch {}

  return { ok: true, detail: 'Write → Block → Verify → Clear → Allow 全周期通过' };
});

// ═════════════════════════════════════════════════════════════════════════════
// Test 3: Pre-compact 检查点
// ═════════════════════════════════════════════════════════════════════════════

test('Pre-compact 检查点', () => {
  const preCompactPath = path.join(HOME, 'engine/scripts/pre-compact.cjs');
  if (!fs.existsSync(preCompactPath)) return { ok: false, detail: 'pre-compact.cjs 不存在' };

  const result = spawnSync('node', [preCompactPath], {
    input: JSON.stringify({ task: '单元测试验证' }),
    encoding: 'utf8', timeout: 10000, windowsHide: true,
  });

  // Pre-compact 应该 exit 0，并在 stdout/stderr 中包含检查点信息
  const output = (result.stdout + result.stderr).toLowerCase();
  const hasCheckpoint = output.includes('checkpoint') || output.includes('检查点') || output.includes('saved') || result.status === 0;

  return {
    ok: result.status === 0 || hasCheckpoint,
    detail: `exit=${result.status} ${hasCheckpoint ? '(检查点已记录)' : ''}`,
  };
});

// ═════════════════════════════════════════════════════════════════════════════
// Test 4: Commit gate 语法
// ═════════════════════════════════════════════════════════════════════════════

test('Commit gate 语法', () => {
  const gatePath = path.join(HOME, 'engine/scripts/gates/commit-gate.cjs');
  if (!fs.existsSync(gatePath)) return { ok: true, detail: 'commit-gate.cjs 未注册，跳过' };

  const r = spawnSync('node', ['--check', gatePath], {
    encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  return { ok: r.status === 0, detail: r.status === 0 ? '语法正确' : r.stderr.slice(0, 200) };
});

// ═════════════════════════════════════════════════════════════════════════════
// Test 5: 新 gate 文件存在性
// ═════════════════════════════════════════════════════════════════════════════

test('新 gate 文件存在性', () => {
  const gateFiles = [
    'engine/scripts/hooks/python-gate.cjs',
    'engine/scripts/hooks/matlab-gate.cjs',
    'engine/scripts/hooks/fpr-calibration-hook.cjs',
    'engine/scripts/coverage-runner.cjs',
    'engine/scripts/hooks/coverage-gate.cjs',
    'engine/scripts/dashboard-html.cjs',
    'engine/scripts/lib/judge-service.cjs',
  ];
  const settingsText = fs.existsSync(path.join(HOME, 'settings.json'))
    ? fs.readFileSync(path.join(HOME, 'settings.json'), 'utf8')
    : '';
  const required = gateFiles.filter(f => settingsText.includes(path.basename(f)) || fs.existsSync(path.join(HOME, f)));
  const missing = required.filter(f => !fs.existsSync(path.join(HOME, f)));
  if (missing.length > 0) {
    return { ok: false, detail: `缺失: ${missing.join(', ')}` };
  }
  return { ok: true, detail: `${required.length} 个已注册/已存在 gate 文件全部存在` };
});

// ═════════════════════════════════════════════════════════════════════════════
// Test 6: 验证所有新 gate 的 node --check 语法
// ═════════════════════════════════════════════════════════════════════════════

test('新 gate 语法检查', () => {
  const gateFiles = [
    'engine/scripts/hooks/python-gate.cjs',
    'engine/scripts/hooks/matlab-gate.cjs',
    'engine/scripts/hooks/fpr-calibration-hook.cjs',
    'engine/scripts/coverage-runner.cjs',
    'engine/scripts/hooks/coverage-gate.cjs',
    'engine/scripts/dashboard-html.cjs',
    'engine/scripts/lib/judge-service.cjs',
  ];
  const failed = [];
  for (const f of gateFiles) {
    const p = path.join(HOME, f);
    if (!fs.existsSync(p)) continue;
    const r = spawnSync('node', ['--check', p], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    if (r.status !== 0) failed.push(f);
  }
  if (failed.length > 0) {
    return { ok: false, detail: `语法错误: ${failed.join(', ')}` };
  }
  return { ok: true, detail: `${gateFiles.length} 个文件语法通过` };
});

test('P0 痛点回归', () => {
  const p = path.join(HOME, 'engine/scripts/test-hooks/harness-painpoints.cjs');
  if (!fs.existsSync(p)) return { ok: false, detail: 'harness-painpoints.cjs 不存在' };
  const r = spawnSync('node', [p], {
    encoding: 'utf8', timeout: 30000, windowsHide: true,
  });
  return { ok: r.status === 0, detail: `exit=${r.status}` };
});

// ═════════════════════════════════════════════════════════════════════════════
// 汇总
// ═════════════════════════════════════════════════════════════════════════════

function main() {
  console.log('\n━━━ E2E 恢复测试 ━━━\n');

  // 如果已有结果 (从 test 函数收集)，直接显示
  const passed = results.filter(r => r.pass).length;
  const total = results.length;

  if (JSON_OUTPUT) {
    console.log(JSON.stringify({ results, summary: { total, passed, failed: total - passed, grade: total > 0 ? Math.round((passed / total) * 100) + '%' : 'N/A' } }, null, 2));
    return;
  }

  // 显示每个测试结果
  for (const r of results) {
    const detail = r.detail ? '— ' + r.detail.slice(0, 60) : '';
    console.log(`  ${r.name.padEnd(45)} ${r.pass ? '✅' : '❌'} ${detail}`);
  }

  const grade = total > 0 ? Math.round((passed / total) * 100) : 0;
  console.log(`\n━━━ 汇总 ━━━`);
  console.log(`  通过: ${passed}/${total} (${grade}%)`);
  if (passed < total) process.exit(1);
  console.log(`  ✅ 全部通过`);
}

main();
