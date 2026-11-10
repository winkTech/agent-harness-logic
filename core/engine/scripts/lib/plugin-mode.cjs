'use strict';

/**
 * engine/scripts/lib/plugin-mode.cjs — 插件模式判定（纯函数）
 *
 * Claude Code 以 `--plugin-dir <root>` 或已安装插件加载本仓库时，会给 hook 进程注入
 * `CLAUDE_PLUGIN_ROOT`。本模块只回答两个问题：
 *   1. 当前进程是不是被插件加载的（isPlugin）；
 *   2. 插件根是不是就是 dev checkout `<homedir>/.claude`（isDevCheckout）。
 * dev checkout 下核心行为契约已由用户级 CLAUDE.md 注入，不需要再注入一遍；
 * 但用户级 settings.json 与插件 hooks 会各跑一次，这正是要告警的双跑形态。
 *
 * 不读文件、不写文件、不碰 process.env 之外的全局状态。
 */

const os = require('node:os');
const path = require('node:path');

/** dev checkout 的固定位置：<homedir>/.claude */
const DEV_CHECKOUT_DIRNAME = '.claude';

/**
 * @param {{env?: object, harnessRoot?: string, homeDir?: string}} [opts]
 * @returns {{pluginRoot: string, isPlugin: boolean, isDevCheckout: boolean}}
 */
function detectPluginMode(opts = {}) {
  const env = opts.env || process.env;
  const homeDir = String(opts.homeDir || os.homedir());

  const raw = env.CLAUDE_PLUGIN_ROOT ? String(env.CLAUDE_PLUGIN_ROOT).trim() : '';
  const isPlugin = Boolean(raw);
  const pluginRoot = isPlugin ? path.resolve(raw) : '';
  const isDevCheckout = isPlugin && pluginRoot === path.resolve(homeDir, DEV_CHECKOUT_DIRNAME);

  return { pluginRoot, isPlugin, isDevCheckout };
}

module.exports = {
  DEV_CHECKOUT_DIRNAME,
  detectPluginMode,
};
