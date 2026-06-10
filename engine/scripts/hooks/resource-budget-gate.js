#!/usr/bin/env node
/**
 * PreToolUse Hook: Resource Budget Gate
 *
 * 在 git push/commit 前检查 FPGA 资源/时序预算。
 * 读项目根目录下的 fpga_constraints.yaml|json，检查综合报告。
 *
 * 如果没有约束文件或综合报告，静默跳过（非阻断）。
 *
 * 配置格式 (fpga_constraints.yaml):
 * ```yaml
 * target:
 *   fmax: 200MHz
 *   lut: 5000
 *   bram: 20
 *   dsp: 16
 *   latency: 12
 * ```
 *
 * 退出码:
 *   0 — 通过或跳过
 *   1 — 超预算（阻断）
 */

'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const MAX_STDIN = 1024 * 1024;
const PREFIX = 'ResourceGate';

function log(msg) {
  process.stderr.write(`[${PREFIX}] ${msg}\n`);
}

// ── YAML 极简解析 ─────────────────────────────────────────────────────────
// 只解析本 schema 需要的两层嵌套结构

function parseMinimalYaml(text) {
  const result = {};
  let currentKey = null;

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('---')) continue;

    const indent = line.search(/\S/);
    const colonIdx = trimmed.indexOf(':');

    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();

    if (value === '' || value === '|') {
      // 嵌套对象
      currentKey = key;
      result[key] = {};
    } else if (currentKey !== null && indent > 0) {
      // 子属性
      result[currentKey][key] = value;
    } else {
      // 顶层属性
      result[key] = value;
      currentKey = null;
    }
  }

  return result;
}

/**
 * 解析值中的数字：处理 "200MHz"、"16"、"5000" 等格式。
 */
function parseNumericValue(val) {
  if (val === undefined || val === null || val === '') return NaN;
  const cleaned = String(val).replace(/[^\d.]/g, '');
  return parseFloat(cleaned);
}

// ── 约束文件加载 ────────────────────────────────────────────────────────────

function findConstraintsFile(projectRoot) {
  // 搜索: fpga_constraints.yaml, fpga_constraints.yml, fpga_constraints.json
  for (const name of ['fpga_constraints.yaml', 'fpga_constraints.yml', 'fpga_constraints.json']) {
    const fullPath = path.join(projectRoot, name);
    if (fs.existsSync(fullPath)) return fullPath;
  }
  return null;
}

function loadConstraints(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const raw = fs.readFileSync(filePath, 'utf8');

  if (ext === '.json') {
    return JSON.parse(raw);
  } else if (ext === '.yaml' || ext === '.yml') {
    return parseMinimalYaml(raw);
  }

  throw new Error(`unsupported format: ${ext}`);
}

// ── 综合报告搜索 ─────────────────────────────────────────────────────────

function findUtilReport(projectRoot) {
  // Vivado 综合报告: *.rpt, 搜索 utilization 关键词
  const searchDirs = [
    projectRoot,
    path.join(projectRoot, 'synth'),
    path.join(projectRoot, 'rpt'),
    path.join(projectRoot, 'reports'),
  ];

  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const files = fs.readdirSync(dir);
      const rptFiles = files.filter(f =>
        f.endsWith('.rpt') && !fs.statSync(path.join(dir, f)).isDirectory()
      );
      for (const f of rptFiles) {
        const content = fs.readFileSync(path.join(dir, f), 'utf8');
        // 检查是否包含资源利用报告特征
        if (content.includes('Slice LUTs') || content.includes('CLB LUTs') || content.includes('| Resource |')) {
          return path.join(dir, f);
        }
      }
    } catch (_) { /* 跳过不可读目录 */ }
  }

  return null;
}

function parseUtilReport(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const resources = {};

  // Vivado 报告格式: "| Slice LUTs | 1234 | 5000 | 24.68 |"
  const tableRegex = /\|\s*([\w\s/]+?)\s*\|\s*([\d,]+)\s*\|\s*([\d,]+)\s*\|\s*([\d.]+)%\s*\|/g;
  let match;
  while ((match = tableRegex.exec(content)) !== null) {
    const name = match[1].trim();
    const used = parseInt(match[2].replace(/,/g, ''), 10);
    resources[name] = used;
  }

  // 从 timing report 提取 Fmax
  const fmaxMatch = content.match(/Fmax[:\s]+([\d.]+)\s*MHz/i)
    || content.match(/Maximum Frequency[:\s]+([\d.]+)\s*MHz/i);
  if (fmaxMatch) {
    resources['Fmax'] = parseFloat(fmaxMatch[1]);
  }

  return resources;
}

// ── 预算检查 ────────────────────────────────────────────────────────────────

function checkBudget(constraints, resources) {
  const issues = [];
  const target = constraints.target || {};

  // 资源映射：约束名 → 报告中的资源名
  const resourceMap = {
    'lut': ['Slice LUTs', 'CLB LUTs', 'LUT', 'LUTs'],
    'ff': ['Slice Registers', 'CLB Registers', 'FF', 'Registers'],
    'bram': ['Block RAM Tile', 'BRAM', 'RAMB36', 'RAMB18'],
    'dsp': ['DSPs', 'DSP48E1', 'DSP48E2', 'DSP'],
  };

  for (const [key, names] of Object.entries(resourceMap)) {
    if (target[key] === undefined) continue;
    const budget = parseNumericValue(target[key]);
    if (isNaN(budget)) continue;

    for (const name of names) {
      if (resources[name] !== undefined && resources[name] > budget) {
        issues.push({
          resource: key,
          used: resources[name],
          budget,
          type: 'over_budget',
        });
        break;
      }
    }
  }

  // Fmax 检查（特殊：实际值应 ≥ 预算值）
  if (target.fmax !== undefined && resources['Fmax'] !== undefined) {
    const budget = parseNumericValue(target.fmax);
    if (!isNaN(budget) && resources['Fmax'] < budget) {
      issues.push({
        resource: 'Fmax',
        used: resources['Fmax'],
        budget,
        type: 'under_budget',
      });
    }
  }

  return issues;
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

async function main() {
  try {
    // 1. 读取 stdin，判断是否 git push/commit
    let raw = '';
    try {
      raw = fs.readFileSync(0, 'utf8').slice(0, MAX_STDIN);
    } catch { /* no stdin */ }

    if (!raw) process.exit(0);

    const payload = JSON.parse(raw);
    const command = (payload?.input?.command || payload?.command || '').trim();

    // 只关心 git push / git commit
    if (!/^git\s+(push|commit)(\s|$)/.test(command)) process.exit(0);

    // 2. 找项目根目录（从 cwd 向上找 .git）
    let projectRoot = process.cwd();
    while (!fs.existsSync(path.join(projectRoot, '.git'))) {
      const parent = path.dirname(projectRoot);
      if (parent === projectRoot) process.exit(0); // 不在 git 仓库内
      projectRoot = parent;
    }

    // 3. 加载约束文件
    const constraintPath = findConstraintsFile(projectRoot);
    if (!constraintPath) process.exit(0); // 无约束文件，跳过

    log(`找到约束文件: ${constraintPath}`);
    let constraints;
    try {
      constraints = loadConstraints(constraintPath);
    } catch (e) {
      log(`⚠ 约束文件解析失败: ${e.message}`);
      process.exit(0); // 解析失败不阻断
    }

    if (!constraints.target || Object.keys(constraints.target).length === 0) {
      log('⚠ 约束文件无 target 定义');
      process.exit(0);
    }

    // 4. 查找综合报告
    const rptPath = findUtilReport(projectRoot);
    if (!rptPath) {
      log('⚠ 未找到综合报告，跳过资源检查');
      process.exit(0);
    }

    log(`使用报告: ${rptPath}`);
    const resources = parseUtilReport(rptPath);

    if (Object.keys(resources).length === 0) {
      log('⚠ 无法解析资源报告');
      process.exit(0);
    }

    // 5. 检查预算
    const issues = checkBudget(constraints, resources);

    if (issues.length === 0) {
      log('✅ 资源预算检查通过');
      process.exit(0);
    }

    // 6. 输出违规信息
    log('');
    log('╔══════════════════════════════════════════════════════════════╗');
    log('║     🔒 RESOURCE BUDGET GATE — BUDGET VIOLATION             ║');
    log('╠══════════════════════════════════════════════════════════════╣');

    for (const issue of issues) {
      if (issue.type === 'over_budget') {
        log(`║  ${issue.resource}: ${issue.used} 使用 > ${issue.budget} 预算`);
      } else {
        log(`║  ${issue.resource}: ${issue.used}MHz < ${issue.budget}MHz 目标`);
      }
    }

    log('╚══════════════════════════════════════════════════════════════╝');
    log('');
    log(`✖ 资源预算检查未通过，已阻断 ${command.split(/\s/)[1]}`);
    log('   请优化设计后重试，或用 --no-verify 跳过');

    process.exit(1);
  } catch (e) {
    log(`跳过（${e.message}）`);
    process.exit(0);
  }
}

main();
