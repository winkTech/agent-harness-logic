#!/usr/bin/env node
/**
 * engine/scripts/hooks/python-gate.cjs — Python 专用门禁 (P0)
 *
 * PreToolUse(Bash) + PreToolUse(Edit|Write) Hook:
 *   1. 检测危险 Python 操作 (golden model 写入、eval/exec、未验证执行)
 *   2. TDD 强制 (新 .py 文件需对应测试文件存在)
 *   3. pip install 路径检查 (禁止 C 盘安装)
 *
 * 退出码:
 *   0 — 安全，放行
 *   2 — 危险，拦截
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// ── 危险模式定义 (Bash 命令扫描) ───────────────────────────────────────────────

const DANGEROUS_PATTERNS = [
  // ===== 1. Python 子进程写入受保护路径 =====
  {
    category: 'python-golden-write',
    severity: 'CRITICAL',
    patterns: [
      // open('matlab/...').write()
      /python.*open\([^)]*(?:matlab|golden|fixed_point)[^)]*\)\s*\.\s*write/i,
      // shutil.copy to protected paths
      /python.*shutil\.(?:copy|move|copy2)\([^)]*(?:matlab|golden|fixed_point)/i,
      // pathlib write_text to protected paths
      /python.*Path\([^)]*(?:matlab|golden|fixed_point)[^)]*\)\s*\.\s*write_text/i,
      // numpy.savetxt/savez to protected paths
      /python.*numpy\.(?:savetxt|savez?)\([^)]*(?:matlab|golden|fixed_point)/i,
      // pandas to_csv/to_excel to protected paths
      /python.*pandas\.(?:DataFrame|Series).*to_csv\([^)]*(?:matlab|golden|fixed_point)/i,
      // pickle.dump to protected paths
      /python.*pickle\.dump\([^,]+,\s*open\([^)]*(?:matlab|golden|fixed_point)/i,
    ],
    message: 'Python 子进程试图写入受保护路径 (golden model)',
  },

  // ===== 2. 不安全的 Python 动态执行 =====
  {
    category: 'python-unsafe-exec',
    severity: 'HIGH',
    patterns: [
      /\bpython\b.*\bexec\s*\(/i,
      /\bpython\b.*\beval\s*\(/i,
      /\bpython\b.*\b__import__\s*\(/i,
      /\bpython\b.*\bcompile\s*\(/i,
      /\bpython\b.*\bpickle\.loads?\b/i,
    ],
    message: '不安全的 Python 动态执行 (exec/eval/pickle)',
  },

  // ===== 3. Python 读取敏感文件 =====
  {
    category: 'python-sensitive-read',
    severity: 'HIGH',
    patterns: [
      // python: open('.env').read()
      /python.*open\([^)]*\.env[^)]*\)\s*\.\s*read/i,
      /python.*open\([^)]*credential[^)]*\)\s*\.\s*read/i,
      // python: dotenv.load_dotenv('.env')
      /python.*dotenv\.load_dotenv\(['"][^'"]*\.env['"]\)/i,
      /python.*load_dotenv\(['"][^'"]*\.env['"]\)/i,
    ],
    message: 'Python 读取敏感文件 (.env/credentials)',
  },

  // ===== 4. C 盘安装检测 (07-system.md) =====
  {
    category: 'python-install-c',
    severity: 'HIGH',
    patterns: [
      /^pip\s+install\b/i,
      /^pip3\s+install\b/i,
    ],
    message: 'pip install 检测: 确保安装到虚拟环境而非全局',
  },

  // ===== 5. 未验证执行 =====
  {
    category: 'python-unverified-run',
    severity: 'MEDIUM',
    patterns: [
      /\bpython\s+.*\.py\b(?!.*--help)(?!.*--version)/i,
      /\bpython3\s+.*\.py\b(?!.*--help)(?!.*--version)/i,
    ],
    message: 'Python 脚本执行: 确认已通过验证',
  },
];

// ── Python 文件写入检查 ────────────────────────────────────────────────────────

const PYTHON_EXTS = ['.py', '.pyw', '.pyx'];
const TEST_PREFIXES = ['test_', 'conftest'];
const TEST_DIRS = ['tests/', 'test/', 'specs/'];

/**
 * 检查 Write/Edit 操作是否涉及新的 Python 模块缺少测试文件 (TDD 强制).
 * @param {string} filePath
 * @returns {string|null} 错误信息，或 null 表示通过
 */
function checkPythonWrite(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!PYTHON_EXTS.includes(ext)) return null;

  const basename = path.basename(filePath);
  // 测试文件本身、conftest.py、__init__.py 不检查
  if (TEST_PREFIXES.some(p => basename.startsWith(p))) return null;
  if (basename === '__init__.py') return null;

  // 已经是测试目录中的文件不检查
  const normalized = filePath.replace(/\\/g, '/');
  if (TEST_DIRS.some(d => normalized.includes('/' + d))) return null;

  // TDD 检查: 如果是新文件 (当前不存在)，必须有对应的测试文件
  if (fs.existsSync(filePath)) return null; // 已有文件，跳过

  const moduleName = basename.replace(/\.pyw?$/, '');
  const testFileName = `test_${moduleName}.py`;
  const projectDir = path.dirname(filePath);

  // 在 tests/ test/ specs/ 目录中查找对应测试文件
  const testPaths = TEST_DIRS.map(d => path.join(projectDir, d, testFileName));
  const rootTestPath = path.join(projectDir, testFileName);

  const anyTestExists = [...testPaths, rootTestPath].some(p => fs.existsSync(p));

  if (!anyTestExists) {
    return `TDD 违规: 新建模块 "${basename}" 需先有测试文件 "${testFileName}" (在 tests/ 目录下)`;
  }

  return null;
}

/**
 * 检查 Python 文件名是否符合规范 (蛇形命名).
 */
function checkPythonNaming(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!PYTHON_EXTS.includes(ext)) return null;

  const basename = path.basename(filePath);
  if (basename === '__init__.py' || basename === '__main__.py') return null;

  const name = basename.replace(/\.pyw?$/, '');
  // Python 模块名应使用蛇形命名: 小写字母、数字、下划线
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    if (!name.startsWith('test_')) {
      return `命名规范: "${basename}" 应使用蛇形命名 (例如: ${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}.py)`;
    }
  }

  return null;
}

// ── 辅助函数 ───────────────────────────────────────────────────────────────────

function readStdin() {
  return new Promise(resolve => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { raw += chunk; });
    process.stdin.on('end', () => resolve(raw));
  });
}

function block(info, detail) {
  console.error('');
  console.error('╔══════════════════════════════════════════════════════════════╗');
  console.error('║      🐍  PYTHON GATE — 操作被阻断                           ║');
  console.error('╠══════════════════════════════════════════════════════════════╣');
  console.error(`║  风险等级: ${(info.severity || 'HIGH').padEnd(40)}║`);
  console.error(`║  类别:     ${(info.category || 'python-violation').padEnd(40)}║`);
  console.error(`║  原因:     ${(info.message || detail || '').padEnd(40)}║`);
  console.error('║                                                              ║');
  console.error('║  此操作被 Python 门禁止执行。                                   ║');
  console.error('╚══════════════════════════════════════════════════════════════╝');
  console.error('');
  console.error(`[PythonGate] BLOCKED: ${info.message || detail}`);
}

function scanCommand(command) {
  if (!command || command.length === 0) {
    return { matched: false, info: null };
  }

  for (const group of DANGEROUS_PATTERNS) {
    for (const regex of group.patterns) {
      if (regex.test(command)) {
        return { matched: true, info: group };
      }
    }
  }

  return { matched: false, info: null };
}

// ── 主逻辑 ────────────────────────────────────────────────────────────────────

async function main() {
  try {
    const raw = await readStdin();
    if (!raw) process.exit(0);

    const payload = JSON.parse(raw);
    const eventName = payload?.hook_event_name || '';
    const toolName = (payload?.tool?.name || payload?.tool_name || payload?.name || '').toLowerCase();

    // ── PreToolUse(Bash): 扫描危险 Python 命令 ──
    if (eventName === 'PreToolUse' && toolName === 'bash') {
      const command = (payload?.tool_input?.command
        || payload?.tool?.input?.command
        || payload?.input?.command
        || payload?.command
        || '').trim();

      if (!command) process.exit(0);

      // 非 Python 命令不做 Bash 级别的 Python 门禁检查
      if (!/python|pip|pytest|ruff/i.test(command)) process.exit(0);

      const { matched, info } = scanCommand(command);
      if (matched) {
        block(info, command);
        process.exit(2);
      }
      process.exit(0);
    }

    // ── PreToolUse(Edit|Write): Python 文件检查 ──
    if (eventName === 'PreToolUse' && (toolName === 'edit' || toolName === 'write')) {
      const filePath = (payload?.tool_input?.file_path
        || payload?.tool?.input?.file_path
        || payload?.input?.file_path
        || payload?.arguments?.file_path
        || '').trim();

      if (!filePath) process.exit(0);

      // 非 Python 文件跳过
      const ext = path.extname(filePath).toLowerCase();
      if (!PYTHON_EXTS.includes(ext)) process.exit(0);

      // 1. TDD 测试文件检查
      const tddError = checkPythonWrite(filePath);
      if (tddError) {
        block({ category: 'python-tdd', severity: 'HIGH', message: tddError });
        process.exit(2);
      }

      // 2. 命名规范检查
      const namingError = checkPythonNaming(filePath);
      if (namingError) {
        block({ category: 'python-naming', severity: 'LOW', message: namingError });
        process.exit(2);
      }

      process.exit(0);
    }

    // ── 其他事件/工具 — 放行 ──
    process.exit(0);

  } catch (e) {
    // 解析失败时不阻断，静默放行
    console.error(`[PythonGate] 解析错误(放行): ${e.message}`);
    process.exit(0);
  }
}

main();
