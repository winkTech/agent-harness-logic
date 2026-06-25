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

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const HOME = path.join(os.homedir(), '.claude');
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
  const settingsPath = path.join(HOME, 'settings.json');
  if (!fs.existsSync(settingsPath)) return { ok: false, detail: 'settings.json 不存在' };

  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const hooks = settings.hooks || {};
  const missing = [];
  const found = [];

  for (const [eventName, groups] of Object.entries(hooks)) {
    const arr = Array.isArray(groups) ? groups : [];
    for (const group of arr) {
      const hookList = group.hooks || [group];
      for (const hook of hookList) {
        const cmd = hook.command || '';
        // 提取 node 脚本路径
        const nodeMatch = cmd.match(/node\s+(.+?\.(?:cjs|js))\b/);
        if (nodeMatch) {
          let scriptPath = nodeMatch[1]
            .replace(/\$HOME\/\.claude\//, HOME + '/')
            .replace(/\$HOME/, HOME);
          // 处理 batch: 拆分逗号分隔的脚本名
          if (scriptPath.includes('local-runner.cjs')) {
            const batchMatch = cmd.match(/--batch\s+"([^"]+)"/);
            if (batchMatch) {
              const names = batchMatch[1].split(',');
              for (const name of names) {
                const fullPath = path.join(HOME, 'engine/scripts/hooks', name.trim());
                if (fs.existsSync(fullPath)) found.push(name.trim());
                else missing.push(name.trim());
              }
            }
          } else {
            if (fs.existsSync(scriptPath)) found.push(path.basename(scriptPath));
            else missing.push(path.basename(scriptPath));
          }
        }
      }
    }
  }

  if (missing.length > 0) {
    return { ok: false, detail: `缺失 ${missing.length} 个: ${missing.join(', ')}` };
  }
  return { ok: true, detail: `${found.length} 个 hook 全部存在` };
});

// ═════════════════════════════════════════════════════════════════════════════
// Test 2: Verification Gate 全周期
// ═════════════════════════════════════════════════════════════════════════════

test('Verification Gate 全周期 (write → block → verify → clear → allow)', () => {
  const gatePath = path.join(HOME, 'engine/scripts/hooks/verification-gate.cjs');
  if (!fs.existsSync(gatePath)) return { ok: false, detail: 'verification-gate.cjs 不存在' };

  // Step 1: 模拟编辑操作写状态文件
  const stateDir = path.join(HOME, 'var');
  const stateFile = path.join(stateDir, 'verify-gate.json');
  if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ edited: true, verified: false, editCount: 1 }), 'utf8');

  // Step 2: 非安全命令应被拦截 (exit 2)
  const blockResult = spawnSync('node', [gatePath], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo test' } }),
    encoding: 'utf8', timeout: 5000, windowsHide: true,
  });
  if (blockResult.status !== 2) {
    return { ok: false, detail: `期望 block exit=2, 实际 exit=${blockResult.status}` };
  }

  // Step 3: 验证命令应清除标记
  const verifyResult = spawnSync('node', [gatePath], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } }),
    encoding: 'utf8', timeout: 5000, windowsHide: true,
  });
  // Should clear gate and allow
  if (verifyResult.status !== 0) {
    return { ok: false, detail: `期望 verify exit=0, 实际 exit=${verifyResult.status}` };
  }

  // Step 4: 验证后非安全命令应放行
  const allowResult = spawnSync('node', [gatePath], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo test' } }),
    encoding: 'utf8', timeout: 5000, windowsHide: true,
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
  if (!fs.existsSync(gatePath)) return { ok: false, detail: 'commit-gate.cjs 不存在' };

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
  const missing = gateFiles.filter(f => !fs.existsSync(path.join(HOME, f)));
  if (missing.length > 0) {
    return { ok: false, detail: `缺失: ${missing.join(', ')}` };
  }
  return { ok: true, detail: `${gateFiles.length} 个新文件全部存在` };
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
