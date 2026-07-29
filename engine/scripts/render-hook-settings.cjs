#!/usr/bin/env node
/**
 * engine/scripts/render-hook-settings.cjs — 把可移植的 hook 注册模板渲染成 settings.json。
 *
 * 背景：
 *   settings.json 被 .gitignore 忽略（hook 命令必须写本机绝对路径，改用 $HOME 会导致 hook
 *   静默不触发）。代价是新克隆与 CI 拿不到任何 hook 注册，而 engine/hooks/manifest.json
 *   声称 active 的条目会因此全部核对不上 —— GitHub CI 上表现为
 *   "hook registry passed (0 script references)" 后跟一串
 *   "manifest marks an unregistered hook active"。
 *
 *   engine/hooks/registrations.json 入库、用 {{HARNESS_ROOT}} 占位，是注册的唯一权威声明；
 *   本脚本把它展开成绝对路径写进 settings.json。
 *
 * 用法：
 *   node engine/scripts/render-hook-settings.cjs            # 渲染并写入 settings.json
 *   node engine/scripts/render-hook-settings.cjs --check    # 只比对，不写；漂移则 exit 1
 *   node engine/scripts/render-hook-settings.cjs --print    # 打印渲染结果到 stdout
 *
 * 退出码：
 *   0 — 成功 / 无漂移
 *   1 — --check 发现 settings.json 的 hooks 与模板不一致
 *   2 — 模板缺失或不可解析
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { HARNESS_ROOT } = require('./lib/harness-root.cjs');

const TEMPLATE_RELATIVE = path.join('engine', 'hooks', 'registrations.json');
const PLACEHOLDER = /\{\{HARNESS_ROOT\}\}/g;

/** settings.json 里的路径一律用正斜杠，与既有写法保持一致。 */
function normalizeRoot(root) {
  return String(root).replace(/\\/g, '/').replace(/\/+$/, '');
}

function templatePath(root = HARNESS_ROOT) {
  return path.join(root, TEMPLATE_RELATIVE);
}

function settingsPath(root = HARNESS_ROOT) {
  return path.join(root, 'settings.json');
}

/**
 * 读取模板并展开占位符，返回 hooks 块。
 * @param {object} [opts]
 * @param {string} [opts.root] — Harness 根目录
 * @returns {object} 渲染后的 hooks 对象
 */
function renderHooks(opts = {}) {
  const root = opts.root || HARNESS_ROOT;
  const file = opts.templatePath || templatePath(root);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const e = new Error(`hook 注册模板不可读: ${file} (${err.code || err.message})`);
    e.exitCode = 2;
    throw e;
  }

  let template;
  try {
    template = JSON.parse(raw);
  } catch (err) {
    const e = new Error(`hook 注册模板不是合法 JSON: ${file} (${err.message})`);
    e.exitCode = 2;
    throw e;
  }

  if (!template.hooks || typeof template.hooks !== 'object') {
    const e = new Error(`hook 注册模板缺少 hooks 字段: ${file}`);
    e.exitCode = 2;
    throw e;
  }

  // 占位符在 command 字符串里，整块序列化后替换最省事，也不会漏掉嵌套层级。
  const expanded = JSON.stringify(template.hooks).replace(PLACEHOLDER, normalizeRoot(root));
  const hooks = JSON.parse(expanded);

  const leftover = JSON.stringify(hooks).match(/\{\{[A-Z_]+\}\}/g);
  if (leftover) {
    const e = new Error(`模板存在未展开的占位符: ${[...new Set(leftover)].join(', ')}`);
    e.exitCode = 2;
    throw e;
  }

  return hooks;
}

/**
 * 把渲染结果合并进 settings.json。
 * 只替换 hooks 字段 —— env / model / statusLine / theme 等本机配置原样保留。
 */
function writeSettings(opts = {}) {
  const root = opts.root || HARNESS_ROOT;
  const target = opts.settingsPath || settingsPath(root);
  const hooks = renderHooks({ root, templatePath: opts.templatePath });

  let existing = {};
  if (fs.existsSync(target)) {
    try {
      existing = JSON.parse(fs.readFileSync(target, 'utf8'));
    } catch (err) {
      // 覆盖一个解析不了的 settings.json 会丢掉里面的本机配置，宁可停下来让人处理。
      const e = new Error(`已有 settings.json 不可解析，拒绝覆盖: ${target} (${err.message})`);
      e.exitCode = 2;
      throw e;
    }
  }

  const merged = { ...existing, hooks };
  fs.writeFileSync(target, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  return { target, hooks, created: !Object.keys(existing).length };
}

/**
 * 稳定序列化：对象键排序、数组保序。
 * JSON 对象本身无序（事件名的先后不影响语义），但同一事件内的 hook 数组是执行顺序，
 * 必须保序 —— 所以只排序键，不动数组。
 */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * 比对 settings.json 的 hooks 与模板渲染结果。
 * @returns {{ drift: boolean, reason: string|null, settingsExists: boolean }}
 */
function checkDrift(opts = {}) {
  const root = opts.root || HARNESS_ROOT;
  const target = opts.settingsPath || settingsPath(root);
  const rendered = renderHooks({ root, templatePath: opts.templatePath });

  if (!fs.existsSync(target)) {
    return { drift: false, reason: null, settingsExists: false, rendered };
  }

  let actual;
  try {
    actual = JSON.parse(fs.readFileSync(target, 'utf8')).hooks || {};
  } catch (err) {
    return { drift: true, reason: `settings.json 不可解析: ${err.message}`, settingsExists: true, rendered };
  }

  if (canonical(rendered) === canonical(actual)) {
    return { drift: false, reason: null, settingsExists: true, rendered };
  }

  const renderedEvents = Object.keys(rendered).sort();
  const actualEvents = Object.keys(actual).sort();
  const onlyTemplate = renderedEvents.filter((e) => !actualEvents.includes(e));
  const onlySettings = actualEvents.filter((e) => !renderedEvents.includes(e));
  const changed = renderedEvents
    .filter((e) => actualEvents.includes(e))
    .filter((e) => canonical(rendered[e]) !== canonical(actual[e]));

  const parts = [];
  if (onlyTemplate.length) parts.push(`模板独有事件: ${onlyTemplate.join(', ')}`);
  if (onlySettings.length) parts.push(`settings.json 独有事件: ${onlySettings.join(', ')}`);
  if (changed.length) parts.push(`注册内容不同的事件: ${changed.join(', ')}`);

  return { drift: true, reason: parts.join('；'), settingsExists: true, rendered };
}

function main() {
  const args = process.argv.slice(2);
  try {
    if (args.includes('--print')) {
      process.stdout.write(`${JSON.stringify(renderHooks(), null, 2)}\n`);
      return 0;
    }

    if (args.includes('--check')) {
      const result = checkDrift();
      if (!result.settingsExists) {
        process.stdout.write('[render-hook-settings] settings.json 不存在，跳过漂移比对\n');
        return 0;
      }
      if (result.drift) {
        process.stderr.write(`[render-hook-settings] ✖ hook 注册漂移: ${result.reason}\n`);
        process.stderr.write('[render-hook-settings]   模板是权威声明。修好模板后跑 '
          + 'node engine/scripts/render-hook-settings.cjs 重新生成 settings.json\n');
        return 1;
      }
      process.stdout.write('[render-hook-settings] ✓ settings.json 的 hooks 与模板一致\n');
      return 0;
    }

    const { target, hooks, created } = writeSettings();
    const count = Object.values(hooks).reduce(
      (sum, groups) => sum + groups.reduce((n, g) => n + (g.hooks?.length || 0), 0), 0,
    );
    process.stdout.write(`[render-hook-settings] ${created ? '已创建' : '已更新'} ${target}`
      + ` (${Object.keys(hooks).length} 个事件 / ${count} 条 hook)\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`[render-hook-settings] ${err.message}\n`);
    return err.exitCode || 2;
  }
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  TEMPLATE_RELATIVE,
  templatePath,
  settingsPath,
  renderHooks,
  writeSettings,
  checkDrift,
};
