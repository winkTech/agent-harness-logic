#!/usr/bin/env node
/**
 * engine/scripts/modelsim-sv-constraints.cjs — ModelSim 10.6c SV 语法约束检查。
 *
 * ModelSim 10.6c 对 SystemVerilog 的支持有限，以下构造不被支持或会被静默忽略。
 * 本脚本扫描 .sv 文件并报告违规。
 *
 * 检测的违规项:
 *   1. always_ff 中声明 automatic 变量
 *   2. 无宽度字面量 ('0, '1, 'x) — ModelSim 可能推导出错误宽度
 *   3. unique / priority case 修饰符 — 10.6c 静默忽略
 *   4. let 声明 — 10.6c 不支持
 *   5. foreach 循环位于 always_comb 中
 *   6. 嵌套 module 声明
 *   7. interface modport 含 clocking block
 *
 * 用法:
 *   node engine/scripts/modelsim-sv-constraints.cjs <file_or_dir>
 *   node engine/scripts/modelsim-sv-constraints.cjs --list     # 列出所有检测项
 *   node engine/scripts/modelsim-sv-constraints.cjs --json <file_or_dir>
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// ── 检测规则定义 ────────────────────────────────────────────────────────────

const RULES = [
  {
    id: 'AUTOMATIC_IN_ALWAYS_FF',
    severity: 'WARN',
    description: 'always_ff 中包含 automatic 变量 — ModelSim 不支持',
    pattern: /always_ff\s*(?:@.*?)?\s*begin\b[\s\S]*?\bautomatic\s+\w+/gi,
    label: 'always_ff 内 automatic 变量',
  },
  {
    id: 'UNTYPED_LITERAL',
    severity: 'WARN',
    description: '无宽度字面量 (\'0, \'1, \'x) — 可能推导错误宽度',
    pattern: /(?<!\d)'[01xXzZ](?!\s*[)a-zA-Z0-9_])/g,
    label: '无宽度字面量',
  },
  {
    id: 'UNIQUE_PRIORITY',
    severity: 'INFO',
    description: 'unique/priority case 修饰符 — ModelSim 10.6c 静默忽略',
    pattern: /^\s*(unique|priority)\s+(case|casex|casez)\b/gim,
    label: 'unique/priority case',
  },
  {
    id: 'LET_DECLARATION',
    severity: 'ERROR',
    description: 'let 声明 — ModelSim 10.6c 不支持',
    pattern: /^\s*let\s+\w+\s*=/gim,
    label: 'let 声明',
  },
  {
    id: 'FOREACH_IN_COMB',
    severity: 'WARN',
    description: 'always_comb 中的 foreach 循环 — 可能在 10.6c 上出问题',
    pattern: /always_comb\s*begin\b.{0,500}\bforeach\s*\(/gi,
    label: 'always_comb 中 foreach',
  },
  {
    id: 'NESTED_MODULE',
    severity: 'ERROR',
    description: '嵌套 module 声明 — ModelSim 10.6c 不支持',
    pattern: /^\s*module\s+\w+\s*[#(]/gm,
    label: '嵌套 module (需上下文确认)',
    // 注意: 这个模式会匹配文件中的所有 module，需要调用者结合行号判断
    // 真正的嵌套检测需要解析 begin/end 范围
  },
  {
    id: 'CLOCKING_IN_MODPORT',
    severity: 'ERROR',
    description: 'modport 中的 clocking block — 10.6c 解析可能失败',
    // 限制跨行匹配范围 (最多 200 字符) 避免灾难性回溯
    pattern: /modport\s+\w+\s*\([^)]{0,200}\bclocking\b[^)]{0,200}\)/gi,
    label: 'modport + clocking',
  },
];

// ── 扫描 ────────────────────────────────────────────────────────────────────

function scanFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const findings = [];

  for (const rule of RULES) {
    // 重置 lastIndex
    rule.pattern.lastIndex = 0;

    let match;
    while ((match = rule.pattern.exec(content)) !== null) {
      // 计算行号
      const lineNum = content.slice(0, match.index).split('\n').length;

      // 跳过注释行中的匹配
      const line = lines[lineNum - 1] || '';
      const stripped = line.replace(/\/\/.*$/, '').trim();
      if (!stripped) continue;

      findings.push({
        rule: rule.id,
        severity: rule.severity,
        label: rule.label,
        line: lineNum,
        snippet: line.trim().slice(0, 80),
      });
    }
  }

  return findings;
}

function scanDir(dirPath) {
  const results = {};
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      // 跳过隐藏目录和常见非源码目录
      if (entry.name.startsWith('.') || entry.name === 'work' || entry.name === 'sim') continue;
      const sub = scanDir(fullPath);
      Object.assign(results, sub);
    } else if (entry.name.endsWith('.sv') || entry.name.endsWith('.svh')) {
      try {
        const findings = scanFile(fullPath);
        if (findings.length > 0) {
          results[fullPath] = findings;
        }
      } catch (e) {
        results[fullPath] = [{ rule: 'PARSE_ERROR', severity: 'ERROR', label: '文件读取错误', line: 0, snippet: e.message }];
      }
    }
  }

  return results;
}

// ── 报告 ────────────────────────────────────────────────────────────────────

function report(results, isJson = false) {
  if (isJson) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  let totalIssues = 0;
  let errorCount = 0;
  let warnCount = 0;
  let infoCount = 0;

  if (typeof results === 'object' && !Array.isArray(results)) {
    // 目录扫描结果
    for (const [file, findings] of Object.entries(results)) {
      console.log(`\n${file}:`);
      for (const f of findings) {
        const icon = f.severity === 'ERROR' ? '❌' : f.severity === 'WARN' ? '⚠️' : 'ℹ️';
        console.log(`  ${icon} [${f.severity}] L${f.line}: ${f.label}`);
        console.log(`      ${f.snippet}`);
        totalIssues++;
        if (f.severity === 'ERROR') errorCount++;
        else if (f.severity === 'WARN') warnCount++;
        else infoCount++;
      }
    }
  } else if (Array.isArray(results)) {
    // 单文件扫描结果
    for (const f of results) {
      const icon = f.severity === 'ERROR' ? '❌' : f.severity === 'WARN' ? '⚠️' : 'ℹ️';
      console.log(`  ${icon} [${f.severity}] L${f.line}: ${f.label}`);
      console.log(`      ${f.snippet}`);
      totalIssues++;
      if (f.severity === 'ERROR') errorCount++;
      else if (f.severity === 'WARN') warnCount++;
      else infoCount++;
    }
  }

  if (totalIssues === 0) {
    console.log('✅ 未发现 ModelSim 10.6c 兼容性问题');
  } else {
    console.log(`\n总数: ${totalIssues} | ❌ 错误: ${errorCount} | ⚠️ 警告: ${warnCount} | ℹ️ 提示: ${infoCount}`);
  }
}

// ── CLI ────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--list')) {
    console.log('ModelSim 10.6c SV 约束检查规则:');
    for (const rule of RULES) {
      const icon = rule.severity === 'ERROR' ? '❌' : rule.severity === 'WARN' ? '⚠️' : 'ℹ️';
      console.log(`  ${icon} [${rule.severity}] ${rule.id}: ${rule.description}`);
    }
    return;
  }

  const target = args.filter(a => !a.startsWith('--'))[0];
  const isJson = args.includes('--json');

  if (!target) {
    console.error('用法: node engine/scripts/modelsim-sv-constraints.cjs <file_or_dir>');
    console.error('       node engine/scripts/modelsim-sv-constraints.cjs --list');
    process.exit(1);
  }

  const fullPath = path.resolve(target);

  if (!fs.existsSync(fullPath)) {
    console.error(`❌ 路径不存在: ${fullPath}`);
    process.exit(1);
  }

  const stat = fs.statSync(fullPath);

  if (stat.isDirectory()) {
    const results = scanDir(fullPath);
    report(results, isJson);
  } else {
    const findings = scanFile(fullPath);
    report(findings, isJson);
    if (findings.some(f => f.severity === 'ERROR')) process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { scanFile, scanDir, RULES };
