#!/usr/bin/env node
/**
 * engine/scripts/coverage-runner.cjs — Hook 覆盖率运行器 (P0)
 *
 * 使用 Node.js 22 内置 NODE_V8_COVERAGE 统计行覆盖率。
 * 零外部依赖 — 仅依赖 Node 标准库。
 *
 * 用法:
 *   node engine/scripts/coverage-runner.cjs                    # 本地 (从 ~/.claude)
 *   node engine/scripts/coverage-runner.cjs --ci <repo-root>   # CI 模式
 *   node engine/scripts/coverage-runner.cjs --check            # 只检查上次结果
 *
 * 阈值: 60% — 低于此值 exit 2
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const COVERAGE_THRESHOLD = 60;

// ── 路径解析 ──────────────────────────────────────────────────────────────────

function resolveRoot() {
  const ciFlag = process.argv.indexOf('--ci');
  if (ciFlag !== -1 && process.argv[ciFlag + 1]) {
    return path.resolve(process.argv[ciFlag + 1]);
  }
  return path.join(os.homedir(), '.claude');
}

const ROOT = resolveRoot();
const RUNNER = path.join(ROOT, 'engine/scripts/test-hooks/run-all-tests.cjs');
const SUMMARY_DIR = path.join(ROOT, 'var', 'coverage');
const SUMMARY_FILE = path.join(SUMMARY_DIR, 'coverage-summary.json');

function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ── V8 Coverage 解析 ─────────────────────────────────────────────────────────

/**
 * 将 V8 字节偏移转换为行号。
 * @param {string[]} lines 源文件行数组
 * @param {number} offset 字节偏移
 * @returns {number} 行号 (0-based)
 */
function byteOffsetToLine(lines, offset) {
  let accumulated = 0;
  for (let i = 0; i < lines.length; i++) {
    accumulated += Buffer.byteLength(lines[i], 'utf8') + 1; // +1 for \n
    if (accumulated > offset) return i;
  }
  return lines.length - 1;
}

/**
 * 解析 V8 覆盖率 JSON，计算行覆盖率。
 * @param {string} coverageDir NODE_V8_COVERAGE 输出目录
 * @returns {{ totalLines: number, coveredLines: number, percent: number, files: number }}
 */
function parseV8Coverage(coverageDir) {
  if (!fs.existsSync(coverageDir)) {
    return { totalLines: 0, coveredLines: 0, percent: 0, files: 0 };
  }

  const coverageFiles = fs.readdirSync(coverageDir).filter(f => f.endsWith('.json'));
  let totalLines = 0;
  let coveredLines = 0;
  const seenFiles = new Set();

  for (const file of coverageFiles) {
    const filePath = path.join(coverageDir, file);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      continue;
    }

    // V8 coverage 格式: { result: [{ url, scriptId, functions }], timestamp }
    const entries = data?.result || (Array.isArray(data) ? data : []);
    for (const entry of entries) {
      const rawUrl = entry.url || '';
      // 只统计项目中的脚本 (file:// 协议且包含 /engine/)
      if (!rawUrl.startsWith('file://') || !rawUrl.includes('/engine/')) continue;

      // 从 file:// URL 提取本地路径
      // file:///C:/Users/... → C:/Users/...  (Windows)
      // file:///home/... → /home/...          (Unix)
      let scriptPath = rawUrl.replace(/^file:\/\//, '');
      // Windows: /C:/... → C:/...
      if (/^\/[A-Za-z]:\\?/.test(scriptPath)) {
        scriptPath = scriptPath.slice(1);
      }
      // URL decode
      try { scriptPath = decodeURIComponent(scriptPath); } catch {}

      if (!fs.existsSync(scriptPath)) continue;
      if (seenFiles.has(scriptPath)) continue;
      seenFiles.add(scriptPath);

      let sourceLines;
      try {
        sourceLines = fs.readFileSync(scriptPath, 'utf8').split('\n');
      } catch {
        continue;
      }

      totalLines += sourceLines.length;

      const coveredLineSet = new Set();
      for (const fn of (entry.functions || [])) {
        for (const range of (fn.ranges || [])) {
          if (range.count > 0) {
            const startLine = byteOffsetToLine(sourceLines, range.startOffset);
            const endLine = byteOffsetToLine(sourceLines, range.endOffset);
            for (let i = startLine; i <= endLine; i++) {
              coveredLineSet.add(i);
            }
          }
        }
      }
      coveredLines += coveredLineSet.size;
    }
  }

  const percent = totalLines > 0 ? Math.round((coveredLines / totalLines) * 100) : 0;
  return { totalLines, coveredLines, percent, files: seenFiles.size };
}

// ── 报告 ──────────────────────────────────────────────────────────────────────

function saveSummary(summary) {
  ensureDir(SUMMARY_DIR);
  fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2), 'utf8');
  return summary;
}

function loadLastSummary() {
  if (fs.existsSync(SUMMARY_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(SUMMARY_FILE, 'utf8'));
    } catch {}
  }
  return null;
}

// ── 主逻辑 ────────────────────────────────────────────────────────────────────

function main() {
  // --check: 只读取上次结果，不重新运行
  if (process.argv.includes('--check')) {
    const last = loadLastSummary();
    if (!last) {
      console.error('[coverage-runner] ⚠️ 无上次覆盖率数据。先运行 node coverage-runner.cjs');
      process.exit(0);
    }
    const threshold = last.threshold || COVERAGE_THRESHOLD;
    if (last.percent >= threshold) {
      console.log(`[coverage-runner] ✅ 上次覆盖率 ${last.percent}% ≥ ${threshold}%`);
      process.exit(0);
    } else {
      console.error(`[coverage-runner] ❌ 上次覆盖率 ${last.percent}% < ${threshold}%`);
      process.exit(2);
    }
  }

  // 检查测试运行器是否存在
  if (!fs.existsSync(RUNNER)) {
    console.error(`[coverage-runner] ❌ 未找到测试运行器: ${RUNNER}`);
    console.error(`[coverage-runner]    ROOT=${ROOT}`);
    process.exit(1);
  }

  // 创建临时目录收集 V8 覆盖率
  const tmpCoverage = path.join(os.tmpdir(), `v8cov-${Date.now()}`);
  ensureDir(tmpCoverage);

  console.log(`[coverage-runner] 🔍 运行测试 (NODE_V8_COVERAGE=${tmpCoverage})...`);

  const result = spawnSync(process.execPath, ['--no-warnings', RUNNER], {
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
    env: {
      ...process.env,
      NODE_V8_COVERAGE: tmpCoverage,
    },
  });

  // 打印测试输出
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  // 解析覆盖率
  console.log(`\n[coverage-runner] 📊 解析覆盖率数据...`);
  const { totalLines, coveredLines, percent, files } = parseV8Coverage(tmpCoverage);

  const summary = {
    timestamp: new Date().toISOString(),
    root: ROOT,
    totalLines,
    coveredLines,
    percent,
    files,
    threshold: COVERAGE_THRESHOLD,
    passed: percent >= COVERAGE_THRESHOLD,
  };

  saveSummary(summary);

  // 清理临时文件
  try { fs.rmSync(tmpCoverage, { recursive: true, force: true }); } catch {}

  // 输出
  console.log('');
  console.log('━━━ V8 覆盖率报告 ━━━');
  console.log(`  检测文件数: ${files}`);
  console.log(`  总行数:     ${totalLines}`);
  console.log(`  覆盖行数:   ${coveredLines}`);
  console.log(`  覆盖率:     ${percent}%`);
  console.log(`  阈值:       ${COVERAGE_THRESHOLD}%`);
  console.log(`  状态:       ${summary.passed ? '✅ 通过' : '❌ 未达标'}`);
  console.log(`  保存至:     ${SUMMARY_FILE}`);

  if (result.status !== 0) {
    console.error(`[coverage-runner] ⚠️ 测试运行 exit=${result.status}`);
  }

  if (!summary.passed) {
    process.exit(2);
  }

  process.exit(0);
}

main();
