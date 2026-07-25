// Shared ECC plugin root resolver
// 检查新旧两种路径以兼容目录重构前后
// 替换 settings.local.json 中 21 处重复的 ~30 行 IIFE
const p = require('node:path');
const f = require('node:fs');
const { HARNESS_ROOT } = require('./lib/harness-root.cjs');
const HOME = HARNESS_ROOT;
const UTILS_REL = p.join('scripts', 'lib', 'utils.js');

function check(dir) {
  try {
    return f.existsSync(p.join(dir, UTILS_REL)) ? dir : null;
  } catch (_) { return null; }
}

function resolve() {
  // 0. Env var override
  const env = process.env.CLAUDE_PLUGIN_ROOT;
  if (env && env.trim()) return env.trim();

  // 1. Direct install paths: var/plugins/ (new) + plugins/ (old)
  const slugs = [
    'ecc', 'ecc@ecc', 'everything-claude-code', 'everything-claude-code@everything-claude-code',
  ];
  for (const base of [
    HOME,
    p.join(HOME, 'var', 'plugins'),
    p.join(HOME, 'plugins'),
    p.join(HOME, 'var', 'plugins', 'marketplaces'),
    p.join(HOME, 'plugins', 'marketplaces'),
  ]) {
    if (check(base)) return base;
    for (const slug of slugs) {
      const dir = p.join(base, slug);
      if (check(dir)) return dir;
    }
  }

  // 2. Cache paths: var/plugins/cache/ + plugins/cache/
  for (const cacheBase of [p.join(HOME, 'var', 'plugins', 'cache'), p.join(HOME, 'plugins', 'cache')]) {
    for (const slug of ['ecc', 'everything-claude-code']) {
      const slugDir = p.join(cacheBase, slug);
      try {
        for (const org of f.readdirSync(slugDir, { withFileTypes: true })) {
          if (!org.isDirectory()) continue;
          for (const ver of f.readdirSync(p.join(slugDir, org.name), { withFileTypes: true })) {
            if (!ver.isDirectory()) continue;
            const found = check(p.join(slugDir, org.name, ver.name));
            if (found) return found;
          }
        }
      } catch (_) { /* 目录可能不存在 */ }
    }
  }

  // 3. Fallback
  return HOME;
}

module.exports = resolve;
