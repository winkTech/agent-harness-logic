#!/usr/bin/env node
'use strict';

/**
 * hosts/antigravity/connect.cjs — Antigravity 插件连接与维护入口（对齐 hosts/codex/connect.cjs）
 *
 * 默认采用方案 A（本机瘦链接开发态，本体留在仓库 hosts/antigravity/）：
 *   - 同步运行时适配器 + 技能/规则/子智能体/清单至 ~/.gemini/config/plugins/logical-paradox
 *   - 写入 .source-root.json 指向本仓库，引擎修改免重装
 *   - 默认在同步完成后施加 OS 级只读 ACL 封固（--no-seal 可显式关闭）
 *
 * 亦支持：
 *   --check         只读零漂移检查（核对运行时适配器、技能、规则与清单）
 *   --refresh       解封 → 强制同步 → 重封固，并在本机 Language Server 可达时触发 MCP 刷新
 *   --portable      从 dist/antigravity-plugin/（便携独立包）部署而非瘦链接模式
 *   --check-dist    校验 dist/antigravity-plugin/ 便携分发包是否与源码零漂移
 *   --unseal        仅解除目标目录 OS 只读 ACL（用于人工排查）
 *   --target <dir>  指定自定义安装目录（测试与 CI 隔离）
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseArgs } = require('node:util');

const { resolveHarnessRoot } = require('./resolve-root.cjs');
const {
  RUNTIME_FILES,
  buildPluginManifest,
  buildMcpConfig,
  buildHooksConfig,
  checkAssets,
  syncPlugin,
} = require('./sync-from-claude.cjs');

const ROOT = resolveHarnessRoot(__dirname).root;
const DEFAULT_PLUGIN_DIR = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'logical-paradox');
const DIST_DIR = path.join(ROOT, 'dist', 'antigravity-plugin');

function loadAcl() {
  return require(path.join(ROOT, 'core', 'engine', 'scripts', 'lib', 'plugin-acl.cjs'));
}

function readNormalized(filePath) {
  return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
}

function checkInstalledDrift(targetDir, opts = {}) {
  const portable = Boolean(opts.portable);
  const drifts = [];
  if (!fs.existsSync(targetDir)) {
    return { ok: false, drifts: [`missing plugin directory: ${targetDir}`] };
  }

  for (const file of RUNTIME_FILES) {
    const src = path.join(__dirname, file);
    const dst = path.join(targetDir, file);
    if (!fs.existsSync(src)) continue;
    if (!fs.existsSync(dst)) {
      drifts.push(`missing runtime file: ${file}`);
      continue;
    }
    if (readNormalized(src) !== readNormalized(dst)) {
      drifts.push(`runtime drift: ${file}`);
    }
  }

  const expectedManifests = [
    ['plugin.json', `${JSON.stringify(buildPluginManifest(ROOT, { packs: opts.packs }), null, 2)}\n`],
    ['mcp_config.json', `${JSON.stringify(buildMcpConfig(ROOT, { portable, packs: opts.packs }), null, 2)}\n`],
    ['hooks.json', `${JSON.stringify(buildHooksConfig(), null, 2)}\n`],
  ];
  for (const [name, expected] of expectedManifests) {
    const file = path.join(targetDir, name);
    if (!fs.existsSync(file) || readNormalized(file) !== expected) {
      drifts.push(`manifest drift: ${name}`);
    }
  }

  const assets = checkAssets(targetDir, null, { root: ROOT, portable, packs: opts.packs });
  if (assets.skip) drifts.push('skills uninitialized');
  for (const d of assets.drift) drifts.push(`asset drift: ${d}`);

  return { ok: drifts.length === 0, drifts };
}

function refreshLanguageServerMcp(serverName = 'logical-paradox_codegraph') {
  const address = process.env.ANTIGRAVITY_LS_ADDRESS;
  const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
  if (!address || !csrf) return Promise.resolve({ attempted: false, reason: 'no-ls-env' });

  return new Promise((resolve) => {
    const [host, portText] = address.split(':');
    const port = Number(portText || 5387);
    const body = JSON.stringify({ serverName });
    const req = http.request({
      hostname: host || 'localhost',
      port,
      path: '/exa.language_server_pb.LanguageServerService/RefreshMcpServers',
      method: 'POST',
      timeout: 3000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-codeium-csrf-token': csrf,
      },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({ attempted: true, ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode }));
    });
    req.on('error', (err) => resolve({ attempted: true, ok: false, reason: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ attempted: true, ok: false, reason: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

function runDistBuilder(args) {
  const script = path.join(ROOT, 'core', 'engine', 'scripts', 'sync-plugin-dist.cjs');
  const res = spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error((res.stderr || res.stdout || `sync-plugin-dist exited ${res.status}`).trim());
  }
  return res.stdout;
}

async function main() {
  const { values } = parseArgs({
    options: {
      check: { type: 'boolean', default: false },
      refresh: { type: 'boolean', default: false },
      portable: { type: 'boolean', default: false },
      'check-dist': { type: 'boolean', default: false },
      unseal: { type: 'boolean', default: false },
      'no-seal': { type: 'boolean', default: false },
      target: { type: 'string' },
      packs: { type: 'string' },
    },
  });

  const targetDir = path.resolve(values.target || DEFAULT_PLUGIN_DIR);
  const acl = loadAcl();

  if (values['check-dist']) {
    if (!fs.existsSync(DIST_DIR)) {
      console.error('[antigravity:connect] dist/antigravity-plugin missing (run sync-plugin-dist.cjs)');
      process.exit(1);
    }
    const drifts = [];
    for (const file of RUNTIME_FILES) {
      const src = path.join(__dirname, file);
      const dst = path.join(DIST_DIR, file);
      if (!fs.existsSync(src)) continue;
      if (!fs.existsSync(dst) || readNormalized(src) !== readNormalized(dst)) {
        drifts.push(`runtime drift: ${file}`);
      }
    }
    const expectedManifests = [
      ['plugin.json', `${JSON.stringify(buildPluginManifest(ROOT), null, 2)}\n`],
      ['mcp_config.json', `${JSON.stringify(buildMcpConfig(ROOT, { portable: true }), null, 2)}\n`],
      ['hooks.json', `${JSON.stringify(buildHooksConfig(), null, 2)}\n`],
    ];
    for (const [name, expected] of expectedManifests) {
      const file = path.join(DIST_DIR, name);
      if (!fs.existsSync(file) || readNormalized(file) !== expected) {
        drifts.push(`manifest drift: ${name}`);
      }
    }
    if (!fs.existsSync(path.join(DIST_DIR, 'core', 'engine', 'scripts', 'lib', 'harness-state.cjs'))) {
      drifts.push('missing bundled core/engine');
    }
    if (fs.existsSync(path.join(DIST_DIR, '.source-root.json'))) {
      drifts.push('portable dist must not include .source-root.json');
    }
    const mcpRaw = fs.existsSync(path.join(DIST_DIR, 'mcp_config.json'))
      ? fs.readFileSync(path.join(DIST_DIR, 'mcp_config.json'), 'utf8')
      : '';
    if (/[A-Za-z]:[\\/]Users[\\/]/i.test(mcpRaw)) {
      drifts.push('portable mcp_config.json leaks machine-local path');
    }
    if (drifts.length) {
      console.error(`[antigravity:connect] dist drift: ${drifts.join('; ')}`);
      process.exit(1);
    }
    console.log('[antigravity:connect] dist/antigravity-plugin OK (zero drift)');
    return;
  }

  if (values.unseal) {
    const out = acl.unsealWritable(targetDir);
    console.log(JSON.stringify({ action: 'unseal', ...out }, null, 2));
    return;
  }

  if (values.check) {
    const isPortable = values.portable
      || fs.existsSync(path.join(targetDir, 'core', 'engine', 'scripts', 'lib', 'harness-state.cjs'));
    const result = checkInstalledDrift(targetDir, { portable: isPortable, packs: values.packs });
    const sealed = acl.isSealed(targetDir);
    if (!result.ok) {
      console.error(`[antigravity:connect] drift detected in ${targetDir}: ${result.drifts.join('; ')}`);
      process.exit(1);
    }
    console.log(`[antigravity:connect] OK (${isPortable ? 'portable' : 'thin-link'}, sealed=${sealed}) ${targetDir}`);
    return;
  }

  const seal = !values['no-seal'];

  const summary = acl.withUnsealedDir(targetDir, () => {
    if (values.portable) {
      const distArgs = values.packs ? [`--packs=${values.packs}`] : [];
      runDistBuilder(distArgs);
      fs.rmSync(targetDir, { recursive: true, force: true });
      fs.cpSync(DIST_DIR, targetDir, { recursive: true });
      return {
        pluginDir: targetDir,
        sourceRoot: ROOT,
        mode: 'portable',
        packs: values.packs || 'all',
        sealed: seal,
      };
    }

    // Option A thin-link mode: canonical sources live in repo hosts/antigravity/.
    // Clean stale engine copy if previously deployed in portable mode.
    fs.rmSync(path.join(targetDir, 'core'), { recursive: true, force: true });
    fs.rmSync(path.join(targetDir, 'packs'), { recursive: true, force: true });
    const synced = syncPlugin({
      root: ROOT,
      target: targetDir,
      portable: false,
      copyRuntime: true,
      packs: values.packs,
    });
    return { ...synced, sealed: seal };
  }, { seal });

  let mcpRefresh = { attempted: false };
  if (values.refresh) {
    mcpRefresh = await refreshLanguageServerMcp('logical-paradox_codegraph');
  }

  console.log(JSON.stringify({ ...summary, mcpRefresh }, null, 2));
}

module.exports = {
  DEFAULT_PLUGIN_DIR,
  DIST_DIR,
  checkInstalledDrift,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(`[antigravity:connect] ${err.message}`);
    process.exit(1);
  });
}
