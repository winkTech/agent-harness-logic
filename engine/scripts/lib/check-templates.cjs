#!/usr/bin/env node
/**
 * engine/scripts/lib/check-templates.cjs — HDL 模板元数据检查。
 *
 * 由 diagnostics.cjs --templates 调用。
 * 检查 skills/hdl-coding/templates/ 下所有模板是否包含规范头部元数据。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const HOME = path.join(os.homedir(), '.claude');
const TEMPLATES_DIR = path.join(HOME, 'skills', 'hdl-coding', 'templates');

// 预期的元数据字段（按域划分）
const META_FIELDS = ['template', 'version', 'domain', 'description'];
const VERSION_RE = /^\d+\.\d+\.\d+$/;

function ok(msg)  { console.log(`  ✅ ${msg}`); }
function warn(msg) { console.log(`  ⚠️  ${msg}`); }
function fail(msg) { console.log(`  ❌ ${msg}`); }
function info(msg) { console.log(`   · ${msg}`); }

/**
 * 解析 Verilog/SystemVerilog 头部注释中的元数据。
 * 格式:
 *   // template: delay_sync
 *   // version: 1.0.0
 *   // domain: comm
 *   // description: ...
 */
function parseTemplateMeta(content) {
  const meta = {};
  // 只读前 50 行
  const lines = content.split('\n').slice(0, 50);

  for (const line of lines) {
    const trimmed = line.trim();
    // 匹配 // key: value 或 //key: value
    const match = trimmed.match(/^\/\/\s*(template|version|domain|description|requires)\s*:\s*(.+)$/i);
    if (match) {
      meta[match[1].toLowerCase()] = match[2].trim();
    }
  }

  return meta;
}

/**
 * 检查单个模板文件。
 */
function checkTemplate(filePath, relPath) {
  const issues = [];

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const meta = parseTemplateMeta(content);

    // 检查必需字段
    for (const field of META_FIELDS) {
      if (!meta[field]) {
        issues.push(`缺少 '${field}' 字段`);
      }
    }

    // 版本号格式
    if (meta.version && !VERSION_RE.test(meta.version)) {
      issues.push(`版本号格式不正确: ${meta.version} (应为 semver x.y.z)`);
    }

    // domain 应与目录名匹配
    const dirName = path.basename(path.dirname(filePath));
    if (meta.domain && meta.domain !== dirName) {
      issues.push(`domain "${meta.domain}" 与目录 "${dirName}" 不匹配`);
    }

    return { ok: issues.length === 0, issues, meta };
  } catch (e) {
    return { ok: false, issues: [`读取失败: ${e.message}`], meta: {} };
  }
}

/**
 * 主入口。
 */
async function checkTemplates() {
  if (!fs.existsSync(TEMPLATES_DIR)) {
    warn(`模板目录不存在: ${TEMPLATES_DIR}`);
    return;
  }

  // 递归收集所有 .v/.sv 文件
  const templates = [];
  function walk(dir, depth = 0) {
    if (depth > 4) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (entry.name.endsWith('.v') || entry.name.endsWith('.sv')) {
        templates.push({ fullPath, relPath: path.relative(TEMPLATES_DIR, fullPath) });
      }
    }
  }
  walk(TEMPLATES_DIR);

  info(`模板文件数: ${templates.length}`);

  let passed = 0;
  let failed = 0;
  let warnings = 0;

  // 按域分组
  const byDomain = {};
  for (const t of templates) {
    const domain = path.dirname(t.relPath).split(path.sep)[0] || '(root)';
    if (!byDomain[domain]) byDomain[domain] = [];
    byDomain[domain].push(t);
  }

  for (const [domain, files] of Object.entries(byDomain)) {
    console.log(`\n  [${domain}] ${files.length} 个模板`);

    for (const t of files) {
      const result = checkTemplate(t.fullPath, t.relPath);

      if (result.ok) {
        const version = result.meta.version || '?';
        ok(`${t.relPath} (v${version})`);
        passed++;
      } else {
        fail(`${t.relPath}`);
        for (const issue of result.issues) {
          warn(`  ${issue}`);
        }
        failed++;
      }
    }
  }

  // 汇总
  console.log('');
  console.log(`  通过: ${passed} | 失败: ${failed} | 警告: ${warnings}`);

  if (failed > 0) {
    console.log('\n  ⚠ 部分模板缺少元数据。建议按以下格式补充:');
    console.log('    // template: <名称>');
    console.log('    // version: 1.0.0');
    console.log('    // domain: comm|alu|internet');
    console.log('    // description: 一句话描述');
  }

  return { passed, failed, warnings };
}

module.exports = { checkTemplates };
