#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { HARNESS_ROOT } = require('./lib/harness-root.cjs');
const { validateHookScripts, validateHookManifest } = require('./lib/hook-registry.cjs');
const { settingsFiles } = require('./lib/harness-root.cjs');
const { validateSchemaCatalog } = require('./lib/schema-catalog.cjs');

function gitFiles(args) {
  const safeRoot = HARNESS_ROOT.replace(/\\/g, '/');
  const result = spawnSync('git', ['-c', `safe.directory=${safeRoot}`, 'ls-files', '-z', ...args], {
    cwd: HARNESS_ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0 || result.error || result.signal) {
    throw new Error(`git ls-files failed: ${result.error?.message || result.stderr || result.signal}`);
  }
  return result.stdout.split('\0').filter(Boolean);
}

function sourceFiles() {
  return [...new Set([
    ...gitFiles([]),
    ...gitFiles(['--others', '--exclude-standard']),
  ])]
    .filter((relative) => fs.existsSync(path.join(HARNESS_ROOT, relative)))
    .sort();
}

function checkNodeSyntax(files) {
  const errors = [];
  for (const relative of files.filter((file) => /\.(?:cjs|mjs|js)$/.test(file))) {
    const result = spawnSync(process.execPath, ['--check', path.join(HARNESS_ROOT, relative)], {
      cwd: HARNESS_ROOT,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.status !== 0 || result.error || result.signal) {
      errors.push(`${relative}: ${result.error?.message || result.stderr || result.signal}`);
    }
  }
  return errors;
}

function checkJson(files) {
  const errors = [];
  for (const relative of files.filter((file) => file.endsWith('.json'))) {
    try {
      JSON.parse(fs.readFileSync(path.join(HARNESS_ROOT, relative), 'utf8'));
    } catch (error) {
      errors.push(`${relative}: ${error.message}`);
    }
  }
  return errors;
}

// settings.json 被 .gitignore 忽略, 因此不在 sourceFiles() 里 —— 它是全harness
// 最关键的文件, 却从不参与 CI 的 JSON 语法校验。这里单独校验它, 并检查两类
// 曾经真实发生过的配置错误。
const VALID_HOOK_EVENTS = new Set([
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'Notification',
  'Stop', 'SubagentStop', 'PreCompact', 'SessionStart', 'SessionEnd',
]);

function checkSettingsFiles() {
  const errors = [];
  for (const file of settingsFiles(HARNESS_ROOT)) {
    if (!fs.existsSync(file)) continue;
    const label = path.basename(file);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      errors.push(`${label}: invalid JSON — ${error.message}`);
      continue;
    }
    for (const [event, groups] of Object.entries(parsed.hooks || {})) {
      // 事件名拼错的整块配置会被平台静默忽略, 表现为"配好了但从不触发"。
      if (!VALID_HOOK_EVENTS.has(event)) {
        errors.push(`${label}: unknown hook event "${event}" — this whole block never fires`);
      }
      for (const group of Array.isArray(groups) ? groups : []) {
        for (const hook of group.hooks || []) {
          // timeout 单位是**秒**。按毫秒填 (如 5000) 等于把上限设成 83 分钟,
          // 所有延迟保护失效。
          if (typeof hook.timeout === 'number' && hook.timeout > 600) {
            errors.push(`${label}: ${event} timeout=${hook.timeout} looks like milliseconds (unit is seconds)`);
          }
        }
      }
    }
  }
  return errors;
}

function checkHookSecurity(files) {
  const errors = [];
  const hookFiles = files.filter((file) => /^(?:engine\/hooks|engine\/scripts\/hooks)\//.test(file)
    && /\.(?:cjs|mjs|js)$/.test(file));
  const forbidden = [
    ['SE-01 shell:true', /shell\s*:\s*true/],
    ['SE-02 Object.assign sink', /Object\.assign\s*\(/],
    ['SE-02 prototype mutation', /__proto__|constructor\s*\.\s*prototype|(?:Object|Reflect)\.setPrototypeOf\s*\(/],
  ];
  for (const relative of hookFiles) {
    const source = fs.readFileSync(path.join(HARNESS_ROOT, relative), 'utf8');
    for (const [label, pattern] of forbidden) {
      if (pattern.test(source)) errors.push(`${relative}: ${label}`);
    }
  }
  return errors;
}

function checkPythonSyntax(files) {
  const pythonFiles = files.filter((file) => file.endsWith('.py'));
  if (pythonFiles.length === 0) return [];
  const candidates = process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
  const executable = candidates.find((candidate) => {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', windowsHide: true });
    return probe.status === 0 && !probe.error && !probe.signal;
  });
  if (!executable) return ['Python files exist but no Python interpreter is available'];

  const script = [
    'import ast, json, pathlib, sys',
    'errors = []',
    'for file_name in json.load(sys.stdin):',
    '    try:',
    "        source = pathlib.Path(file_name).read_text(encoding='utf-8-sig')",
    '        ast.parse(source, filename=file_name)',
    '    except Exception as error:',
    "        errors.append(f'{file_name}: {error}')",
    "print('\\n'.join(errors))",
    'raise SystemExit(1 if errors else 0)',
  ].join('\n');
  const absoluteFiles = pythonFiles.map((file) => path.join(HARNESS_ROOT, file));
  const result = spawnSync(executable, ['-c', script], {
    cwd: HARNESS_ROOT,
    encoding: 'utf8',
    input: JSON.stringify(absoluteFiles),
    windowsHide: true,
  });
  if (result.status === 0 && !result.error && !result.signal) return [];
  return [result.error?.message || result.stdout || result.stderr || result.signal || 'Python syntax check failed'];
}

// 渲染零漂移族（Phase 1.5）：单一真源的三个渲染/同步器必须 --check 全绿。
// 漂移 = 有人改了产物没改真源，或改了真源忘重渲染——都在这里被抓住。
function runRenderFamilyChecks() {
  const scripts = [
    'core/engine/scripts/render-hook-settings.cjs',
    'core/engine/scripts/sync-workflow-mirror.cjs',
    'core/engine/scripts/sync-skills.cjs',
    // Phase 3.1：Codex 双产物（hooks.json + AGENTS.md 投影）零漂移看守。
    'core/engine/scripts/render-codex-hooks.cjs',
  ];
  const errors = [];
  const checks = [];
  for (const relative of scripts) {
    const result = spawnSync(process.execPath, [path.join(HARNESS_ROOT, relative), '--check'], {
      cwd: HARNESS_ROOT,
      encoding: 'utf8',
      timeout: 120000,
      windowsHide: true,
    });
    if (result.status !== 0) {
      const firstLine = String(result.stderr || result.stdout || '').trim().split('\n')[0] || '';
      errors.push(`render family: ${relative} --check exit=${result.status}${firstLine ? ` — ${firstLine}` : ''}`);
    } else {
      checks.push(path.basename(relative, '.cjs').replace(/\.cjs$/, ''));
    }
  }
  return { errors, checks };
}

// Hook 延迟档位硬门 (M4a): warm p95 按 hook-latency.cjs 的档位表判定。
// CI 机器比 dev 机器慢, 用 CLAUDE_HARNESS_LATENCY_SCALE=3 整体放大预算 ——
// 放大的是绝对阈值, 档位之间的相对关系不变。
// 无 hook 注册 / 无可测同步入口时**显式 skip 并说明原因**, 不静默通过 (规则 8)。
function runLatencySla() {
  const script = path.join(HARNESS_ROOT, 'core', 'engine', 'scripts', 'lib', 'bench-hooks.cjs');
  const result = spawnSync(process.execPath, [script, '--quick', '--json', '--sla'], {
    cwd: HARNESS_ROOT,
    encoding: 'utf8',
    timeout: 180000,
    windowsHide: true,
    env: {
      ...process.env,
      CLAUDE_HARNESS_ROOT: HARNESS_ROOT,
      CLAUDE_HARNESS_LATENCY_SCALE: '3',
      CLAUDE_HARNESS_NO_PERSIST: '1',
      CLAUDE_NO_DIAGNOSTIC_WRITES: '1',
    },
  });
  if (result.error || result.signal) {
    return { errors: [`hook latency SLA: bench-hooks 未能运行 — ${result.error?.message || `signal=${result.signal}`}`] };
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout || '');
  } catch (error) {
    return { errors: [`hook latency SLA: bench-hooks 输出不是 JSON — ${error.message} ${(result.stderr || result.stdout || '').slice(0, 200)}`] };
  }
  // settings.json 被 .gitignore 忽略, 新克隆/CI 上可能一条 hook 都注册不到。
  if (parsed.error) return { skip: parsed.reason || parsed.error };
  const sla = parsed.sla;
  if (!sla) return { errors: ['hook latency SLA: bench-hooks --sla 未产出 sla 字段'] };
  if (sla.checks.length === 0) {
    const reasons = [...new Set((sla.skipped || []).map(entry => entry.reason))].join(', ') || 'unknown';
    return { skip: `无可测同步入口 (${sla.skipped?.length || 0} 条全部跳过: ${reasons})` };
  }
  if (!sla.pass) {
    return {
      errors: sla.violations.map(v => `hook latency SLA: ${v.script} warm p95 ${v.warm_p95_ms}ms > 预算 ${v.budget_ms}ms (档位 ${v.tier}, scale ${sla.scale})`),
    };
  }
  return { sla };
}

function runCoverage() {
  const script = path.join(HARNESS_ROOT, 'core', 'engine', 'scripts', 'coverage-runner.cjs');
  return spawnSync(process.execPath, [script, '--ci', HARNESS_ROOT], {
    cwd: HARNESS_ROOT,
    encoding: 'utf8',
    // 外层预算必须 > coverage-runner 的 RUNNER_TIMEOUT_MS (420 s) + 覆盖率解析开销,
    // 否则调大内层毫无意义 —— 原值 180000 比套件本身的 max 192.8 s 还小, 是先被砍的那一层。
    timeout: 600000,
    windowsHide: true,
    env: {
      ...process.env,
      CLAUDE_HARNESS_ROOT: HARNESS_ROOT,
      CLAUDE_HARNESS_NO_PERSIST: '1',
      CLAUDE_HARNESS_VERIFY_READONLY: '1',
      CLAUDE_NO_DIAGNOSTIC_WRITES: '1',
    },
  });
}

function fail(errors) {
  for (const error of errors) console.error(`[harness-ci] FAIL ${error}`);
  process.exit(1);
}

function main() {
  // Phase 1.6：分层执法器先行（§3.3 依赖方向 + 宿主词耦合，零白名单挂载）
  const boundary = spawnSync(process.execPath, [path.join(HARNESS_ROOT, 'core/engine/scripts/layer-boundary.cjs'), '--check'], {
    cwd: HARNESS_ROOT,
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
  });
  if (boundary.status !== 0) {
    process.stdout.write(boundary.stdout || '');
    fail([`layer boundary: exit=${boundary.status}`]);
  }
  process.stdout.write(boundary.stdout || '');

  const files = sourceFiles();
  const staticErrors = [
    ...checkNodeSyntax(files),
    ...checkPythonSyntax(files),
    ...checkJson(files),
    ...checkSettingsFiles(),
    ...checkHookSecurity(files),
  ];
  if (staticErrors.length > 0) fail(staticErrors);
  console.log(`[harness-ci] static integrity passed (${files.length} source files)`);

  const hooks = validateHookScripts({ root: HARNESS_ROOT });
  if (hooks.missing.length > 0) {
    fail(hooks.missing.map((entry) => `missing hook target: ${entry.script}`));
  }
  console.log(`[harness-ci] hook registry passed (${hooks.found.length} script references)`);

  const hookManifest = validateHookManifest({ root: HARNESS_ROOT });
  if (hookManifest.errors.length > 0) fail(hookManifest.errors.map(error => `hook manifest: ${error}`));
  console.log(`[harness-ci] hook manifest passed (${hookManifest.checked} active registrations)`);

  const schemas = validateSchemaCatalog();
  if (schemas.errors.length > 0) fail(schemas.errors);
  console.log(`[harness-ci] schema catalog passed (${schemas.files.length} schemas)`);

  const renderFamily = runRenderFamilyChecks();
  if (renderFamily.errors.length > 0) fail(renderFamily.errors);
  console.log(`[harness-ci] render family passed (${renderFamily.checks.join(' + ')})`);

  const latency = runLatencySla();
  if (latency.errors) fail(latency.errors);
  if (latency.skip) {
    console.log(`[harness-ci] hook latency SLA skipped — ${latency.skip}`);
  } else {
    const worst = [...latency.sla.checks].sort((a, b) => (b.warm_p95_ms / b.budget_ms) - (a.warm_p95_ms / a.budget_ms))[0];
    console.log(`[harness-ci] hook latency SLA passed (${latency.sla.checks.length} entries, scale ${latency.sla.scale}, worst ${worst.script} ${worst.warm_p95_ms}ms/${worst.budget_ms}ms)`);
  }

  const coverage = runCoverage();
  if (coverage.stdout) process.stdout.write(coverage.stdout);
  if (coverage.stderr) process.stderr.write(coverage.stderr);
  if (coverage.status !== 0 || coverage.error || coverage.signal) {
    fail([`coverage/regression exit=${coverage.status} error=${coverage.error?.message || 'none'} signal=${coverage.signal || 'none'}`]);
  }

  console.log('[harness-ci] all gates passed');
}

main();
