#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { gitSubcommand } = require('./verification-gate.cjs');

const MAX_STDIN = 1024 * 1024;
const PREFIX = 'ResourceGate';

function log(message) {
  process.stderr.write(`[${PREFIX}] ${message}\n`);
}

function parseMinimalYaml(text) {
  const result = {};
  let currentKey = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('---')) continue;
    const indent = line.search(/\S/);
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex === -1) continue;
    const key = trimmed.slice(0, colonIndex).trim();
    const value = trimmed.slice(colonIndex + 1).trim();
    if (value === '' || value === '|') {
      currentKey = key;
      result[key] = {};
    } else if (currentKey !== null && indent > 0) {
      result[currentKey][key] = value;
    } else {
      result[key] = value;
      currentKey = null;
    }
  }
  return result;
}

function parseNumericValue(value) {
  if (value === undefined || value === null || value === '') return Number.NaN;
  return Number.parseFloat(String(value).replace(/[^\d.]/g, ''));
}

function findConstraintsFile(projectRoot) {
  for (const name of ['fpga_constraints.yaml', 'fpga_constraints.yml', 'fpga_constraints.json']) {
    const filePath = path.join(projectRoot, name);
    if (fs.existsSync(filePath)) return filePath;
  }
  return null;
}

function loadConstraints(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const raw = fs.readFileSync(filePath, 'utf8');
  if (extension === '.json') return JSON.parse(raw);
  if (extension === '.yaml' || extension === '.yml') return parseMinimalYaml(raw);
  throw new Error(`unsupported format: ${extension}`);
}

function findUtilReport(projectRoot) {
  const searchDirs = [
    projectRoot,
    path.join(projectRoot, 'synth'),
    path.join(projectRoot, 'rpt'),
    path.join(projectRoot, 'reports'),
  ];
  for (const directory of searchDirs) {
    if (!fs.existsSync(directory)) continue;
    try {
      const reportNames = fs.readdirSync(directory)
        .filter((name) => name.endsWith('.rpt') && !fs.statSync(path.join(directory, name)).isDirectory());
      for (const name of reportNames) {
        const filePath = path.join(directory, name);
        const content = fs.readFileSync(filePath, 'utf8');
        if (content.includes('Slice LUTs') || content.includes('CLB LUTs') || content.includes('| Resource |')) {
          return filePath;
        }
      }
    } catch {
      // Unreadable report directories are advisory and therefore skipped.
    }
  }
  return null;
}

function parseUtilReport(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const resources = {};
  const tableRegex = /\|\s*([\w\s/]+?)\s*\|\s*([\d,]+)\s*\|\s*([\d,]+)\s*\|\s*([\d.]+)%\s*\|/g;
  let match;
  while ((match = tableRegex.exec(content)) !== null) {
    resources[match[1].trim()] = Number.parseInt(match[2].replace(/,/g, ''), 10);
  }
  const fmaxMatch = content.match(/Fmax[:\s]+([\d.]+)\s*MHz/i)
    || content.match(/Maximum Frequency[:\s]+([\d.]+)\s*MHz/i);
  if (fmaxMatch) resources.Fmax = Number.parseFloat(fmaxMatch[1]);
  return resources;
}

function checkBudget(constraints, resources) {
  const issues = [];
  const target = constraints.target || {};
  const resourceMap = {
    lut: ['Slice LUTs', 'CLB LUTs', 'LUT', 'LUTs'],
    ff: ['Slice Registers', 'CLB Registers', 'FF', 'Registers'],
    bram: ['Block RAM Tile', 'BRAM', 'RAMB36', 'RAMB18'],
    dsp: ['DSPs', 'DSP48E1', 'DSP48E2', 'DSP'],
  };
  for (const [key, names] of Object.entries(resourceMap)) {
    if (target[key] === undefined) continue;
    const budget = parseNumericValue(target[key]);
    if (Number.isNaN(budget)) continue;
    for (const name of names) {
      if (resources[name] !== undefined && resources[name] > budget) {
        issues.push({ resource: key, used: resources[name], budget, type: 'over_budget' });
        break;
      }
    }
  }
  if (target.fmax !== undefined && resources.Fmax !== undefined) {
    const budget = parseNumericValue(target.fmax);
    if (!Number.isNaN(budget) && resources.Fmax < budget) {
      issues.push({ resource: 'Fmax', used: resources.Fmax, budget, type: 'under_budget' });
    }
  }
  return issues;
}

function commandFrom(payload) {
  return String(
    payload?.tool_input?.command
    || payload?.tool?.input?.command
    || payload?.input?.command
    || payload?.command
    || ''
  ).trim();
}

function cwdFrom(payload, runtime = {}) {
  return path.resolve(
    runtime.cwd
    || payload?.cwd
    || payload?.workspace?.current_dir
    || process.cwd()
  );
}

function findProjectRoot(startPath) {
  let current = path.resolve(startPath);
  while (!fs.existsSync(path.join(current, '.git'))) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return current;
}

function evaluate(payload, runtime = {}) {
  const command = commandFrom(payload);
  if (!gitSubcommand(command)) {
    return { source: 'resource-budget-gate', decision: 'allow', diagnostics: [] };
  }
  try {
    const projectRoot = findProjectRoot(cwdFrom(payload, runtime));
    if (!projectRoot) return { source: 'resource-budget-gate', decision: 'allow', diagnostics: [] };
    const constraintPath = findConstraintsFile(projectRoot);
    if (!constraintPath) return { source: 'resource-budget-gate', decision: 'allow', diagnostics: [] };

    const diagnostics = [`找到约束文件: ${constraintPath}`];
    let constraints;
    try {
      constraints = loadConstraints(constraintPath);
    } catch (error) {
      diagnostics.push(`⚠️ 约束文件解析失败: ${error.message}`);
      return { source: 'resource-budget-gate', decision: 'allow', diagnostics, error: error.message };
    }
    if (!constraints.target || Object.keys(constraints.target).length === 0) {
      diagnostics.push('⚠️ 约束文件无 target 定义');
      return { source: 'resource-budget-gate', decision: 'allow', diagnostics };
    }

    const reportPath = runtime.reportPath || findUtilReport(projectRoot);
    if (!reportPath) {
      diagnostics.push('⚠️ 未找到综合报告，跳过资源检查');
      return { source: 'resource-budget-gate', decision: 'allow', diagnostics };
    }
    diagnostics.push(`使用报告: ${reportPath}`);
    const resources = parseUtilReport(reportPath);
    if (Object.keys(resources).length === 0) {
      diagnostics.push('⚠️ 无法解析资源报告');
      return { source: 'resource-budget-gate', decision: 'allow', diagnostics };
    }

    const issues = checkBudget(constraints, resources);
    if (issues.length === 0) {
      diagnostics.push('✅ 资源预算检查通过');
      return { source: 'resource-budget-gate', decision: 'allow', diagnostics, resources };
    }
    diagnostics.push('', 'RESOURCE BUDGET GATE — BUDGET VIOLATION');
    for (const issue of issues) {
      diagnostics.push(issue.type === 'over_budget'
        ? `${issue.resource}: ${issue.used} 使用 > ${issue.budget} 预算`
        : `${issue.resource}: ${issue.used}MHz < ${issue.budget}MHz 目标`);
    }
    diagnostics.push(
      `⚠️ 资源预算检查未通过 (${command.split(/\s/)[1]})`,
      '   建议优化设计后重试；确认可接受则可继续。',
    );
    return {
      source: 'resource-budget-gate',
      decision: 'warn',
      diagnostics,
      issues,
      resources,
      legacyExitCode: 1,
    };
  } catch (error) {
    return {
      source: 'resource-budget-gate',
      decision: 'allow',
      diagnostics: [`跳过：${error.message}`],
      error: error.message,
    };
  }
}

function readStdin() {
  try {
    if (!process.stdin.isTTY) return fs.readFileSync(0, 'utf8').slice(0, MAX_STDIN).replace(/^\uFEFF/, '');
  } catch {
    // No stdin is a normal standalone invocation.
  }
  return '';
}

function main() {
  const raw = readStdin();
  if (!raw) process.exit(0);
  try {
    const result = evaluate(JSON.parse(raw));
    for (const message of result.diagnostics) log(message);
    if (result.legacyExitCode === 1) process.exit(1);
  } catch (error) {
    log(`跳过：${error.message}`);
  }
  process.exit(0);
}

if (require.main === module) main();

module.exports = {
  checkBudget,
  commandFrom,
  evaluate,
  findConstraintsFile,
  findProjectRoot,
  findUtilReport,
  loadConstraints,
  parseMinimalYaml,
  parseNumericValue,
  parseUtilReport,
};
