/**
 * workflows-registry.cjs
 *
 * 轻量级工作流注册表 — 动态扫描 workflows/ 目录，
 * 从每个 .js 文件的 export const meta 中提取名称和描述。
 *
 * 用法:
 *   const registry = require('./workflows-registry.cjs');
 *   registry.list();           // [{name, description, filePath}, ...]
 *   registry.resolve('hdl-coding-dag-workflow');  // 绝对路径
 *   registry.validate();       // 一致性校验
 */

const fs = require('node:fs');
const path = require('node:path');

const WORKFLOWS_DIR = path.resolve(__dirname, '..', 'workflows');

/**
 * 从 .js 文件内容中提取 meta 对象中的 name 和 description。
 * 使用正则匹配 export const meta = { ... } 块中的 key: value 对。
 */
function parseMeta(fileContent) {
  const meta = {};

  // 从 export const meta = { 开始, 到匹配的 } 结束
  const metaMatch = fileContent.match(/export\s+const\s+meta\s*=\s*\{/);
  if (!metaMatch) return meta;

  const startIdx = metaMatch.index;
  // 简单的大括号匹配，找到闭合的 }
  let depth = 0;
  let endIdx = -1;
  for (let i = startIdx; i < fileContent.length; i++) {
    const ch = fileContent[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }
  if (endIdx === -1) return meta;

  const metaBlock = fileContent.slice(startIdx, endIdx + 1);

  // 提取 name: '...' 或 name: "..."
  const nameMatch = metaBlock.match(/^\s*name\s*:\s*['"]([^'"]+)['"]/m);
  if (nameMatch) meta.name = nameMatch[1];

  // 提取 description: '...' 或 description: "..." (可能跨行)
  const descMatch = metaBlock.match(/^\s*description\s*:\s*['"]([^'"]+)['"]/m);
  if (descMatch) meta.description = descMatch[1];

  return meta;
}

/**
 * 扫描 workflows/ 目录，返回所有已注册工作流的元信息。
 */
function scan() {
  const entries = [];

  if (!fs.existsSync(WORKFLOWS_DIR)) {
    console.error(`[workflows-registry] 警告: workflows 目录不存在: ${WORKFLOWS_DIR}`);
    return entries;
  }

  const files = fs.readdirSync(WORKFLOWS_DIR);
  for (const file of files) {
    if (!file.endsWith('.js')) continue;
    const filePath = path.join(WORKFLOWS_DIR, file);
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) continue;

    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = parseMeta(content);

    entries.push({
      name: parsed.name || path.basename(file, '.js'),
      description: parsed.description || '',
      filePath,
    });
  }

  return entries;
}

// 按名称索引，惰性初始化
let _cache = null;

function ensureCache() {
  if (!_cache) {
    _cache = scan();
  }
  return _cache;
}

/**
 * 根据工作流名称 resolve 出绝对文件路径。
 * @param {string} workflowName
 * @returns {string} 绝对路径
 * @throws {Error} 未找到时抛出
 */
function resolve(workflowName) {
  const entry = ensureCache().find((e) => e.name === workflowName);
  if (!entry) {
    const available = ensureCache().map((e) => `  - ${e.name}`).join('\n');
    throw new Error(
      `工作流 "${workflowName}" 未注册。\n可用工作流:\n${available}`
    );
  }
  return entry.filePath;
}

/**
 * 返回所有已注册工作流的列表。
 * @returns {Array<{name: string, description: string, filePath: string}>}
 */
function list() {
  return ensureCache().map((e) => ({ ...e }));
}

/**
 * 校验所有注册是否一致：每个文件确实存在且可读，name 不重复。
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
function validate() {
  const errors = [];
  const warnings = [];
  const entries = ensureCache();
  const nameSet = new Set();

  for (const entry of entries) {
    // 文件存在
    if (!fs.existsSync(entry.filePath)) {
      errors.push(`文件不存在: ${entry.filePath}`);
      continue;
    }
    try {
      fs.accessSync(entry.filePath, fs.constants.R_OK);
    } catch {
      errors.push(`文件不可读: ${entry.filePath}`);
    }

    // name 重复
    if (nameSet.has(entry.name)) {
      errors.push(`工作流名称重复: "${entry.name}"`);
    }
    nameSet.add(entry.name);

    // name 从文件名派生但没写 description
    if (!entry.description && entry.name === path.basename(entry.filePath, '.js')) {
      warnings.push(`"${entry.name}" 缺少 description`);
    }
  }

  // 检查有无 .js 文件被漏扫 (meta 缺失)
  const allFiles = fs.readdirSync(WORKFLOWS_DIR).filter(
    (f) => f.endsWith('.js') && fs.statSync(path.join(WORKFLOWS_DIR, f)).isFile()
  );
  const registeredFiles = new Set(entries.map((e) => path.basename(e.filePath)));
  for (const f of allFiles) {
    if (!registeredFiles.has(f)) {
      warnings.push(`文件 "${f}" 被扫到但未注册 (缺少 export const meta?)`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

module.exports = { resolve, list, validate };
