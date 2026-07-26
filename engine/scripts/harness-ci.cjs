#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { HARNESS_ROOT } = require('./lib/harness-root.cjs');
const { validateHookScripts } = require('./lib/hook-registry.cjs');
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
  'PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Notification',
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

function runCoverage() {
  const script = path.join(HARNESS_ROOT, 'engine', 'scripts', 'coverage-runner.cjs');
  return spawnSync(process.execPath, [script, '--ci', HARNESS_ROOT], {
    cwd: HARNESS_ROOT,
    encoding: 'utf8',
    timeout: 180000,
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

  const schemas = validateSchemaCatalog();
  if (schemas.errors.length > 0) fail(schemas.errors);
  console.log(`[harness-ci] schema catalog passed (${schemas.files.length} schemas)`);

  const coverage = runCoverage();
  if (coverage.stdout) process.stdout.write(coverage.stdout);
  if (coverage.stderr) process.stderr.write(coverage.stderr);
  if (coverage.status !== 0 || coverage.error || coverage.signal) {
    fail([`coverage/regression exit=${coverage.status} error=${coverage.error?.message || 'none'} signal=${coverage.signal || 'none'}`]);
  }

  console.log('[harness-ci] all gates passed');
}

main();
