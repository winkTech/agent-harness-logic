#!/usr/bin/env node
/**
 * engine/scripts/render-hook-settings.cjs — 多目标 hook 注册渲染器。
 *
 * 背景：
 *   settings.json 被 .gitignore 忽略（hook 命令必须写本机绝对路径，改用 $HOME 会导致 hook
 *   静默不触发）。代价是新克隆与 CI 拿不到任何 hook 注册，而 engine/hooks/manifest.json
 *   声称 active 的条目会因此全部核对不上 —— GitHub CI 上表现为
 *   "hook registry passed (0 script references)" 后跟一串
 *   "manifest marks an unregistered hook active"。
 *
 *   engine/hooks/registrations.json 入库、用 {{HARNESS_ROOT}} 占位，是注册的唯一权威声明；
 *   本脚本把它展开成绝对路径写入目标。Phase 1 起为**多目标渲染器**：
 *     - Claude Code：settings.json（hooks 块，向后兼容，历史渲染语义不变）
 *     - WorkBuddy：engine/hooks/workbuddy.hooks.json（插件 hooks.json 结构与 Claude
 *       同构 —— 事件名/matcher/hooks/type:command 一致，已对真实插件样例核对）
 *     - Claude Code 插件：engine/hooks/plugin.hooks.json（入库产物，命令用 exec 形式
 *       {command:"node", args:["${CLAUDE_PLUGIN_ROOT}/..."]}，插件根每次更新都换目录，
 *       写死绝对路径必然失效）
 *
 * 用法：
 *   node engine/scripts/render-hook-settings.cjs            # 渲染并写入三个目标
 *   node engine/scripts/render-hook-settings.cjs --check    # 只比对，不写；任一目标漂移则 exit 1
 *   node engine/scripts/render-hook-settings.cjs --print    # 打印 Claude 目标 hooks 到 stdout
 *   node engine/scripts/render-hook-settings.cjs --print-workbuddy  # 打印 WorkBuddy 目标到 stdout
 *   node engine/scripts/render-hook-settings.cjs --print-plugin     # 打印插件目标到 stdout
 *
 * 退出码：
 *   0 — 成功 / 无漂移
 *   1 — --check 发现任一目标与模板不一致
 *   2 — 模板缺失或不可解析
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { HARNESS_ROOT } = require('./lib/harness-root.cjs');

const TEMPLATE_RELATIVE = path.join('engine', 'hooks', 'registrations.json');
const WORKBUDDY_TARGET_RELATIVE = path.join('engine', 'hooks', 'workbuddy.hooks.json');
const PLUGIN_TARGET_RELATIVE = path.join('engine', 'hooks', 'plugin.hooks.json');
const PLUGIN_ROOT_PLACEHOLDER = '${CLAUDE_PLUGIN_ROOT}';
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

// ── WorkBuddy 目标 ──────────────────────────────────────────────────────────
// WorkBuddy 插件 hooks.json 与 Claude settings.json 的 hooks 块同构（事件名 /
// matcher / hooks / type:command / command / timeout 字段一致，已对真实插件样例
// sheetagent / financial-analysis 核对）。因此 registrations.json 单一契约源
// 直接复用，占位符展开成绝对路径后包一层 { hooks } 即为 WorkBuddy 目标。

function workbuddyHooksPath(root = HARNESS_ROOT) {
  return path.join(root, WORKBUDDY_TARGET_RELATIVE);
}

/**
 * 传输层标注（M3）：入口用 `--transport <name>` 在边界识别一次运行时。
 * 只有 WorkBuddy 目标需要显式标注 —— Claude 的 settings.json 与 plugin.hooks.json
 * 默认即 claude-code，追加只会让本机注册产生无谓漂移。
 */
const WORKBUDDY_TRANSPORT_FLAG = '--transport workbuddy';

function withWorkbuddyTransport(hook) {
  const command = String(hook?.command || '');
  if (!command) return hook;
  if (parseArgvTokens(command).includes('--transport')) return hook;
  return { ...hook, command: `${command} ${WORKBUDDY_TRANSPORT_FLAG}` };
}

function parseArgvTokens(command) {
  return String(command).trim().split(/\s+/);
}

/**
 * 渲染 WorkBuddy 目标（顶层 { hooks } 结构，命令末尾带 `--transport workbuddy`）。
 * @returns {{ hooks: object }}
 */
function renderWorkbuddyHooks(opts = {}) {
  const root = opts.root || HARNESS_ROOT;
  const rendered = renderHooks({ root, templatePath: opts.templatePath });
  const hooks = {};
  for (const [event, groups] of Object.entries(rendered)) {
    hooks[event] = (Array.isArray(groups) ? groups : []).map((group) => (
      Array.isArray(group?.hooks)
        ? { ...group, hooks: group.hooks.map(withWorkbuddyTransport) }
        : withWorkbuddyTransport(group)
    ));
  }
  return { hooks };
}

/**
 * 写入 workbuddy.hooks.json。独立文件（非合并进 settings.json），
 * 每次全量覆写模板渲染结果。
 */
function writeWorkbuddyHooks(opts = {}) {
  const root = opts.root || HARNESS_ROOT;
  const target = opts.workbuddyPath || workbuddyHooksPath(root);
  const rendered = renderWorkbuddyHooks({ root, templatePath: opts.templatePath });
  fs.writeFileSync(target, `${JSON.stringify(rendered, null, 2)}\n`, 'utf8');
  const count = Object.values(rendered.hooks).reduce(
    (sum, groups) => sum + groups.reduce((n, g) => n + (g.hooks?.length || 0), 0), 0,
  );
  return { target, hooks: rendered.hooks, count };
}

/**
 * 比对 workbuddy.hooks.json 与模板渲染结果。
 */
function checkWorkbuddyDrift(opts = {}) {
  const root = opts.root || HARNESS_ROOT;
  const target = opts.workbuddyPath || workbuddyHooksPath(root);
  const rendered = renderWorkbuddyHooks({ root, templatePath: opts.templatePath });

  if (!fs.existsSync(target)) {
    return { drift: false, reason: null, targetExists: false, rendered };
  }

  let actual;
  try {
    actual = JSON.parse(fs.readFileSync(target, 'utf8')).hooks || {};
  } catch (err) {
    return { drift: true, reason: `workbuddy.hooks.json 不可解析: ${err.message}`, targetExists: true, rendered };
  }

  if (canonical(rendered.hooks) === canonical(actual)) {
    return { drift: false, reason: null, targetExists: true, rendered };
  }

  const renderedEvents = Object.keys(rendered.hooks).sort();
  const actualEvents = Object.keys(actual).sort();
  const onlyTemplate = renderedEvents.filter((e) => !actualEvents.includes(e));
  const onlyTarget = actualEvents.filter((e) => !renderedEvents.includes(e));
  const changed = renderedEvents
    .filter((e) => actualEvents.includes(e))
    .filter((e) => canonical(rendered.hooks[e]) !== canonical(actual[e]));

  const parts = [];
  if (onlyTemplate.length) parts.push(`模板独有事件: ${onlyTemplate.join(', ')}`);
  if (onlyTarget.length) parts.push(`workbuddy.hooks.json 独有事件: ${onlyTarget.join(', ')}`);
  if (changed.length) parts.push(`注册内容不同的事件: ${changed.join(', ')}`);

  return { drift: true, reason: parts.join('；'), targetExists: true, rendered };
}

// ── Claude Code 插件目标 ────────────────────────────────────────────────────
// 插件 hooks.json 的 hooks 块与 settings.json 同构，但两点不同：
//   1. 路径不能是本机绝对路径 —— 插件每次更新是**新建版本目录**，旧目录 14 天后清理，
//      写死的绝对路径必然失效。用官方占位符 ${CLAUDE_PLUGIN_ROOT}。
//   2. 命令用 exec 形式 {"command":"node","args":[...]} —— 无 shell 参与，
//      插件根路径含空格时也不会被拆开（Windows 下的默认安装路径就含空格）。
// 因此本目标从同一模板渲染：占位符展开成 ${CLAUDE_PLUGIN_ROOT}，再把命令行拆成 argv。

function pluginHooksPath(root = HARNESS_ROOT) {
  return path.join(root, PLUGIN_TARGET_RELATIVE);
}

/**
 * "node ${CLAUDE_PLUGIN_ROOT}/engine/x.cjs --flag"
 *   → { type:'command', command:'node', args:['${CLAUDE_PLUGIN_ROOT}/engine/x.cjs','--flag'] }
 * 其余字段（timeout、async 等）原样保留。
 * 非 node 命令不静默降级 —— 插件目标不经 shell，bash/内联脚本无法执行，必须让人改模板。
 */
function toExecForm(hook) {
  const command = String(hook?.command || '');
  if (!/^node\s+\S/.test(command)) {
    const e = new Error(`插件目标只接受以 "node " 开头的模板命令，无法转换: ${command || '<empty>'}`);
    e.exitCode = 2;
    throw e;
  }
  const argv = command.trim().split(/\s+/);
  return { ...hook, type: 'command', command: 'node', args: argv.slice(1) };
}

/**
 * 渲染 Claude Code 插件目标（顶层 { hooks } 结构，exec 形式命令）。
 * @returns {{ hooks: object }}
 */
function renderPluginHooks(opts = {}) {
  const root = opts.root || HARNESS_ROOT;
  // 模板路径按真实 root 解析；占位符则展开成插件根占位符而非绝对路径。
  const rendered = renderHooks({
    root: PLUGIN_ROOT_PLACEHOLDER,
    templatePath: opts.templatePath || templatePath(root),
  });

  const hooks = {};
  for (const [event, groups] of Object.entries(rendered)) {
    hooks[event] = (Array.isArray(groups) ? groups : []).map((group) => ({
      ...group,
      hooks: (Array.isArray(group.hooks) ? group.hooks : [group]).map(toExecForm),
    }));
  }
  return { hooks };
}

/** 写入 plugin.hooks.json（入库产物，全量覆写）。 */
function writePluginHooks(opts = {}) {
  const root = opts.root || HARNESS_ROOT;
  const target = opts.pluginPath || pluginHooksPath(root);
  const rendered = renderPluginHooks({ root, templatePath: opts.templatePath });
  fs.writeFileSync(target, `${JSON.stringify(rendered, null, 2)}\n`, 'utf8');
  const count = Object.values(rendered.hooks).reduce(
    (sum, groups) => sum + groups.reduce((n, g) => n + (g.hooks?.length || 0), 0), 0,
  );
  return { target, hooks: rendered.hooks, count };
}

/** 比对 plugin.hooks.json 与模板渲染结果。 */
function checkPluginDrift(opts = {}) {
  const root = opts.root || HARNESS_ROOT;
  const target = opts.pluginPath || pluginHooksPath(root);
  const rendered = renderPluginHooks({ root, templatePath: opts.templatePath });

  if (!fs.existsSync(target)) {
    return { drift: false, reason: null, targetExists: false, rendered };
  }

  let actual;
  try {
    actual = JSON.parse(fs.readFileSync(target, 'utf8')).hooks || {};
  } catch (err) {
    return { drift: true, reason: `plugin.hooks.json 不可解析: ${err.message}`, targetExists: true, rendered };
  }

  if (canonical(rendered.hooks) === canonical(actual)) {
    return { drift: false, reason: null, targetExists: true, rendered };
  }

  const renderedEvents = Object.keys(rendered.hooks).sort();
  const actualEvents = Object.keys(actual).sort();
  const onlyTemplate = renderedEvents.filter((e) => !actualEvents.includes(e));
  const onlyTarget = actualEvents.filter((e) => !renderedEvents.includes(e));
  const changed = renderedEvents
    .filter((e) => actualEvents.includes(e))
    .filter((e) => canonical(rendered.hooks[e]) !== canonical(actual[e]));

  const parts = [];
  if (onlyTemplate.length) parts.push(`模板独有事件: ${onlyTemplate.join(', ')}`);
  if (onlyTarget.length) parts.push(`plugin.hooks.json 独有事件: ${onlyTarget.join(', ')}`);
  if (changed.length) parts.push(`注册内容不同的事件: ${changed.join(', ')}`);

  return { drift: true, reason: parts.join('；'), targetExists: true, rendered };
}

function main() {
  const args = process.argv.slice(2);
  try {
    if (args.includes('--print')) {
      process.stdout.write(`${JSON.stringify(renderHooks(), null, 2)}\n`);
      return 0;
    }

    if (args.includes('--print-workbuddy')) {
      process.stdout.write(`${JSON.stringify(renderWorkbuddyHooks(), null, 2)}\n`);
      return 0;
    }

    if (args.includes('--print-plugin')) {
      process.stdout.write(`${JSON.stringify(renderPluginHooks(), null, 2)}\n`);
      return 0;
    }

    if (args.includes('--check')) {
      const claude = checkDrift();
      const workbuddy = checkWorkbuddyDrift();
      const plugin = checkPluginDrift();
      const failures = [];
      if (claude.settingsExists && claude.drift) {
        failures.push(`[claude settings.json] ${claude.reason}`);
      }
      if (workbuddy.targetExists && workbuddy.drift) {
        failures.push(`[workbuddy.hooks.json] ${workbuddy.reason}`);
      }
      if (plugin.targetExists && plugin.drift) {
        failures.push(`[plugin.hooks.json] ${plugin.reason}`);
      }
      if (failures.length) {
        for (const failure of failures) process.stderr.write(`[render-hook-settings] ✖ hook 注册漂移: ${failure}\n`);
        process.stderr.write('[render-hook-settings]   模板是权威声明。修好模板后跑 '
          + 'node engine/scripts/render-hook-settings.cjs 重新生成\n');
        return 1;
      }
      const bits = [];
      if (claude.settingsExists) bits.push('settings.json 的 hooks 与模板一致');
      else bits.push('settings.json 不存在，跳过漂移比对');
      if (workbuddy.targetExists) bits.push('workbuddy.hooks.json 与模板一致');
      else bits.push('workbuddy.hooks.json 不存在，跳过漂移比对');
      if (plugin.targetExists) bits.push('plugin.hooks.json 与模板一致');
      else bits.push('plugin.hooks.json 不存在，跳过漂移比对');
      process.stdout.write(`[render-hook-settings] ✓ ${bits.join('；')}\n`);
      return 0;
    }

    const { target, hooks, created } = writeSettings();
    const count = Object.values(hooks).reduce(
      (sum, groups) => sum + groups.reduce((n, g) => n + (g.hooks?.length || 0), 0), 0,
    );
    process.stdout.write(`[render-hook-settings] ${created ? '已创建' : '已更新'} ${target}`
      + ` (${Object.keys(hooks).length} 个事件 / ${count} 条 hook)\n`);

    const wb = writeWorkbuddyHooks();
    process.stdout.write(`[render-hook-settings] 已更新 ${wb.target}`
      + ` (${Object.keys(wb.hooks).length} 个事件 / ${wb.count} 条 hook)\n`);

    const plugin = writePluginHooks();
    process.stdout.write(`[render-hook-settings] 已更新 ${plugin.target}`
      + ` (${Object.keys(plugin.hooks).length} 个事件 / ${plugin.count} 条 hook)\n`);
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
  WORKBUDDY_TARGET_RELATIVE,
  PLUGIN_TARGET_RELATIVE,
  PLUGIN_ROOT_PLACEHOLDER,
  templatePath,
  settingsPath,
  workbuddyHooksPath,
  pluginHooksPath,
  renderHooks,
  writeSettings,
  checkDrift,
  renderWorkbuddyHooks,
  writeWorkbuddyHooks,
  checkWorkbuddyDrift,
  WORKBUDDY_TRANSPORT_FLAG,
  withWorkbuddyTransport,
  toExecForm,
  renderPluginHooks,
  writePluginHooks,
  checkPluginDrift,
};
