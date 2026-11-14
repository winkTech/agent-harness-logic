'use strict';

/**
 * core/engine/scripts/hooks/plugin-session-context.cjs — SessionStart 的两个插件模式组件
 *
 * 由 session-bootstrap.cjs 在 stateResume 之前路由，返回形状与其它组件一致：
 * `{ exitCode, context }`。两者都 fail-open：任何异常只写一行 stderr warning，
 * exitCode 恒为 0，绝不影响会话启动。
 *
 *  - coreCapsule：插件安装模式（非 dev checkout）下，用户机器上没有本仓库的 CLAUDE.md，
 *    把插件根的 CLAUDE.md 作为核心行为契约注入 additionalContext。
 *  - registrationOverlap：插件 hooks 与用户级 settings.json 的 hooks 会各跑一次，
 *    检测到重叠就告警，让用户二选一。
 *
 * 只读；不写状态、不 spawn 子进程。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { detectPluginMode } = require('../lib/plugin-mode.cjs');

/** 核心胶囊注入上限（字符） */
const CAPSULE_LIMIT = 6000;
/** 胶囊首行前缀 */
const CAPSULE_PREFIX = '[logical-paradox] 核心行为契约（插件模式注入）';
/** 判定“用户级 settings 也注册了 harness hook”的脚本名 */
const HARNESS_ROUTER_SCRIPTS = Object.freeze([
  'preflight-router.cjs',
  'postflight-router.cjs',
  'prompt-context.cjs',
  'session-bootstrap.cjs',
  'stop-summary.cjs',
]);
/** 用户级 settings 文件名（相对 <homeDir>/.claude） */
const USER_SETTINGS_FILES = Object.freeze(['settings.json', 'settings.local.json']);

function warn(io, component, message) {
  const line = JSON.stringify({
    source: 'plugin-session-context',
    type: 'warning',
    component,
    message: String(message || ''),
  });
  if (io && typeof io.stderr === 'function') io.stderr(line);
  else process.stderr.write(`${line}\n`);
}

/** 去掉 Markdown 的一级标题（含其后的空行）；没有一级标题时原样返回。 */
function stripTopHeading(text) {
  const lines = String(text).split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i += 1;
  if (i < lines.length && /^#\s+\S/.test(lines[i])) {
    i += 1;
    while (i < lines.length && lines[i].trim() === '') i += 1;
  }
  return lines.slice(i).join('\n').trim();
}

/**
 * 插件安装模式下注入核心行为契约。dev checkout 与非插件模式返回空 context。
 * @returns {{exitCode: number, context?: string}}
 */
function coreCapsule(_payload, io, deps = {}) {
  try {
    const mode = detectPluginMode({ env: deps.env, homeDir: deps.homeDir });
    if (!mode.isPlugin || mode.isDevCheckout) return { exitCode: 0 };

    const capsulePath = path.join(mode.pluginRoot, 'CLAUDE.md');
    let raw;
    try {
      raw = fs.readFileSync(capsulePath, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return { exitCode: 0 };
      throw error;
    }

    let body = stripTopHeading(raw);
    if (!body) return { exitCode: 0 };
    if (body.length > CAPSULE_LIMIT) {
      body = `${body.slice(0, CAPSULE_LIMIT)}\n…（已截断，完整内容见 ${capsulePath}）`;
    }
    return { exitCode: 0, context: `${CAPSULE_PREFIX}\n\n${body}` };
  } catch (error) {
    warn(io, 'coreCapsule', error.message);
    return { exitCode: 0 };
  }
}

/** 读取一个用户级 settings 文件的 hooks 块，返回其 JSON 文本（读不到/无 hooks → ''）。 */
function readUserHooksText(settingsPath) {
  let raw;
  try {
    raw = fs.readFileSync(settingsPath, 'utf8');
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'EISDIR')) return '';
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return '';
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.hooks) return '';
  return JSON.stringify(parsed.hooks);
}

/**
 * 插件副本与用户副本双跑告警。dev checkout 同样告警（那正是要抓的形态）。
 * @returns {{exitCode: number, context?: string}}
 */
function registrationOverlap(_payload, io, deps = {}) {
  try {
    const mode = detectPluginMode({ env: deps.env, homeDir: deps.homeDir });
    if (!mode.isPlugin) return { exitCode: 0 };

    const homeDir = String(deps.homeDir || os.homedir());
    const settingsDir = path.join(homeDir, '.claude');
    let overlapped = false;
    for (const name of USER_SETTINGS_FILES) {
      const hooksText = readUserHooksText(path.join(settingsDir, name));
      if (hooksText && HARNESS_ROUTER_SCRIPTS.some(script => hooksText.includes(script))) {
        overlapped = true;
        break;
      }
    }
    if (!overlapped) return { exitCode: 0 };

    const remove = path.join(mode.pluginRoot, 'core', 'engine', 'scripts', 'render-hook-settings.cjs');
    return {
      exitCode: 0,
      context: '[logical-paradox] 检测到用户级 settings.json 也注册了 harness hook，'
        + '插件副本与用户副本会各跑一次；请二选一：卸载插件，或运行 '
        + `node ${remove} --remove-user-hooks`
        + '（M2 暂未实现，先手工从 settings.json 删除 hooks 块）',
    };
  } catch (error) {
    warn(io, 'registrationOverlap', error.message);
    return { exitCode: 0 };
  }
}

module.exports = {
  CAPSULE_LIMIT,
  CAPSULE_PREFIX,
  HARNESS_ROUTER_SCRIPTS,
  USER_SETTINGS_FILES,
  stripTopHeading,
  coreCapsule,
  registrationOverlap,
};
