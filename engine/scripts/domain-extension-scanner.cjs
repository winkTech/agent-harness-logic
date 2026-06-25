#!/usr/bin/env node
/**
 * engine/scripts/domain-extension-scanner.cjs — 领域扩展扫描器
 *
 * 🔍 P2-3: 领域扩展
 * 参照: [2] SWE-bench — 将评估体系扩展到更多领域
 *
 * 扫描项目目录，检测可应用评估体系的非 HDL 文件类型，
 * 并生成适配建议。帮助将 Harness 从 HDL-only 扩展到
 * Python/MATLAB/C 等领域。
 *
 * 用法:
 *   node engine/scripts/domain-extension-scanner.cjs scan [dir]
 *   node engine/scripts/domain-extension-scanner.cjs report
 *   node engine/scripts/domain-extension-scanner.cjs analyze <file>
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const HOME = path.join(os.homedir(), '.claude');

// ── 领域定义 ────────────────────────────────────────────────────────────────

const DOMAINS = {
  python: {
    exts: ['.py'],
    testPatterns: ['test_*.py', '*_test.py'],
    lintCmd: 'ruff check',
    testCmd: 'pytest',
    priority: 'high',
    description: 'Python — 算法建模/脚本/测试',
  },
  matlab: {
    exts: ['.m'],
    testPatterns: [],
    lintCmd: '无内置 linter（MCP check_matlab_code）',
    testCmd: '无标准化测试框架',
    priority: 'high',
    description: 'MATLAB — 算法原型/Golden Model',
  },
  javascript: {
    exts: ['.js', '.cjs', '.mjs'],
    testPatterns: ['*.test.js', '*.spec.js', 'test_*.js'],
    lintCmd: 'eslint / biome',
    testCmd: 'jest / vitest / mocha',
    priority: 'medium',
    description: 'JavaScript/Node.js — 脚本/工具',
  },
  c_cpp: {
    exts: ['.c', '.cpp', '.h', '.hpp'],
    testPatterns: [],
    lintCmd: 'cppcheck / clang-tidy',
    testCmd: 'ctest / gtest',
    priority: 'low',
    description: 'C/C++ — 驱动/嵌入式',
  },
};

// ── 统计 ────────────────────────────────────────────────────────────────────

function scanDirectory(dir) {
  if (!fs.existsSync(dir)) {
    console.error(`目录不存在: ${dir}`);
    return null;
  }

  const stats = {};
  for (const domain of Object.keys(DOMAINS)) {
    stats[domain] = { files: 0, loc: 0, testFiles: 0, detected: false };
  }

  // 文件统计
  const allFiles = [];
  function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && entry.name !== 'node_modules') walk(full);
      } else {
        allFiles.push(full);
      }
    }
  }
  walk(dir);

  for (const file of allFiles) {
    const ext = path.extname(file);
    for (const [domain, def] of Object.entries(DOMAINS)) {
      if (def.exts.includes(ext)) {
        stats[domain].files++;
        try {
          const content = fs.readFileSync(file, 'utf8');
          stats[domain].loc += content.split('\n').length;
        } catch {}
        // 检测是否为测试文件
        const basename = path.basename(file);
        for (const pattern of def.testPatterns) {
          const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
          if (regex.test(basename)) { stats[domain].testFiles++; break; }
        }
        break;
      }
    }
  }

  // 检测已有评估基础设施
  for (const [domain, def] of Object.entries(DOMAINS)) {
    if (stats[domain].files === 0) continue;
    // 检查是否有对应的 gate 或 hook
    const gateFiles = {
      python: fs.existsSync(path.join(HOME, 'engine/scripts/hooks/hdl-gate.cjs')) ? 'hdl-gate (不适用)' : '无专用 gate',
      matlab: '无专用 gate (受 golden model 保护规则保护)',
      javascript: '通过 verification-gate 和 commit-gate 部分覆盖',
      c_cpp: '无专用 gate',
    };
    stats[domain].existingGates = gateFiles[domain] || '无';
    stats[domain].detected = true;
  }

  return { directory: dir, stats, totalFiles: allFiles.length };
}

// ── 报告 ────────────────────────────────────────────────────────────────────

function generateReport(scanned) {
  if (!scanned) {
    console.log('[domain-extension] 未扫描。运行 scan <dir> 先生成数据。');
    return;
  }

  console.log('\n━━━ 领域扩展评估报告 ━━━');
  console.log(`📂 扫描目录: ${scanned.directory}`);
  console.log(`📊 总文件数: ${scanned.totalFiles}`);
  console.log('');

  console.log('领域分布:');
  console.log('');

  for (const [domain, s] of Object.entries(scanned.stats)) {
    const def = DOMAINS[domain];
    if (s.files === 0) continue;

    const icon = s.files > 10 ? '🟢' : s.files > 3 ? '🟡' : '⚪';
    console.log(`  ${icon} ${domain.padEnd(12)} ${String(s.files).padEnd(5)} 文件  ${String(s.loc).padEnd(8)} 行  ${s.testFiles} 测试文件`);
    console.log(`     现有 gate: ${s.existingGates || '无'}`);
    console.log(`     lint: ${def.lintCmd}`);
    console.log(`     测试: ${def.testCmd}`);
    console.log(`     建议: ${getSuggestion(domain, s)}`);
    console.log('');
  }

  // 总结
  const extendable = Object.entries(scanned.stats).filter(([, s]) => s.files > 5 && s.detected);
  if (extendable.length > 0) {
    console.log('🎯 优先扩展领域:');
    for (const [domain] of extendable) {
      const def = DOMAINS[domain];
      console.log(`   ${domain} — ${def.description}`);
      console.log(`     创建: engine/rules/${domain}.md`);
      console.log(`     创建: engine/scripts/hooks/${domain}-gate.cjs`);
      console.log(`     集成: commit-gate 中注册 ${domain}-lint`);
    }
    console.log('');
  }
}

function getSuggestion(domain, stats) {
  const suggestions = {
    python: stats.files > 10
      ? '✅ 已有 ruff 支持。建议创建 python-gate.cjs 专用 gate，在 commit-gate 中强化 pytest 前置检查。'
      : 'Python 文件较少，现有 ruff check 覆盖已够。',
    matlab: stats.files > 5
      ? '⚠️ 仅受 golden model 保护规则保护。建议创建 matlab-gate.cjs 补充 MATLAB MCP lint 检查。'
      : 'MATLAB 文件较少，现有 protection 覆盖已够。',
    javascript: stats.files > 5
      ? '⚠️ 通过通用 gate 间接覆盖。建议创建 js-gate.cjs 补充 eslint 检查。'
      : 'JS 文件较少，现有 coverage 已够。',
    c_cpp: stats.files > 5
      ? '❌ 无专用检查。建议创建 cpp-gate.cjs。'
      : 'C/C++ 文件较少，暂不优先。',
  };
  return suggestions[domain] || '无需特殊处理。';
}

// ── 单文件分析 ──────────────────────────────────────────────────────────────

function analyzeFile(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`文件不存在: ${filePath}`);
    return;
  }

  const ext = path.extname(filePath);
  const domain = Object.entries(DOMAINS).find(([, d]) => d.exts.includes(ext));

  if (!domain) {
    console.log(`未知文件类型: ${ext}`);
    return;
  }

  const [name, def] = domain;
  console.log(`\n━━━ 文件分析 ━━━`);
  console.log(`  文件: ${path.basename(filePath)}`);
  console.log(`  领域: ${name} — ${def.description}`);
  console.log(`  大小: ${fs.statSync(filePath).size} bytes`);
  console.log(`  lint: ${def.lintCmd}`);
  console.log(`  测试: ${def.testCmd}`);
  console.log('');

  if (def.exts.includes('.py')) {
    // 运行 ruff 检查
    const { spawnSync } = require('node:child_process');
    const r = spawnSync('ruff', ['check', '--quiet', filePath], {
      encoding: 'utf8', timeout: 10000,
    });
    if (r.status === 0) {
      console.log('  ✅ ruff: 无问题');
    } else {
      const issues = r.stdout.split('\n').filter(Boolean).length;
      console.log(`  ⚠️  ruff: ${issues} 个问题`);
    }
  }
}

// ── CLI ────────────────────────────────────────────────────────────────────

function main() {
  const cmd = process.argv[2];

  switch (cmd) {
    case 'scan': {
      const dir = process.argv[3] || process.cwd();
      const result = scanDirectory(dir);
      if (result) generateReport(result);
      break;
    }

    case 'report':
      // 从上次扫描结果读取
      const resultsFile = path.join(HOME, 'var', 'domain-scan-results.json');
      if (fs.existsSync(resultsFile)) {
        const data = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
        generateReport(data);
      } else {
        console.log('[domain-extension] 无缓存扫描结果。先运行 scan。');
      }
      break;

    case 'analyze':
      analyzeFile(process.argv[3]);
      break;

    default:
      console.log(`
用法:
  node engine/scripts/domain-extension-scanner.cjs scan [dir]    # 扫描目录
  node engine/scripts/domain-extension-scanner.cjs report        # 查看报告
  node engine/scripts/domain-extension-scanner.cjs analyze <file> # 单文件分析
`);
  }

  // 保存扫描结果
  if (cmd === 'scan') {
    const dir = process.argv[3] || process.cwd();
    const result = scanDirectory(dir);
    if (result) {
      const rf = path.join(HOME, 'var', 'domain-scan-results.json');
      fs.writeFileSync(rf, JSON.stringify(result, null, 2), 'utf8');
    }
  }
}

main();
