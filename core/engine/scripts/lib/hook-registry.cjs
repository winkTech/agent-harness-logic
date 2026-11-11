'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { expandHome, resolvePath } = require('./project-scope.cjs');
const { HARNESS_ROOT, settingsFiles } = require('./harness-root.cjs');

const HOME = HARNESS_ROOT;
const DEFAULT_SETTINGS_FILES = settingsFiles(HOME);
// Phase 1.1/1.3：manifest 与 plugin.hooks.json 随拆层迁至 core/engine/hooks/。
const MANIFEST_RELATIVE_PATH = path.join('core', 'engine', 'hooks', 'manifest.json');
const PLUGIN_HOOKS_RELATIVE_PATH = path.join('core', 'engine', 'hooks', 'plugin.hooks.json');
const PLUGIN_ROOT_PLACEHOLDER = /\$\{CLAUDE_PLUGIN_ROOT\}/g;
// Phase 2.1：工具事件集读 host-concepts 合同（原硬编码 Set）。
const HOST_CONCEPTS_MODULE = require('./host-concepts.cjs');
const TOOL_EVENTS = new Set(Object.entries(
  HOST_CONCEPTS_MODULE.HOST_DIALECTS['claude-code'].events,
).filter(([, action]) => action === 'before_tool' || action === 'after_tool' || action === 'after_tool_failure')
  .map(([nativeEvent]) => nativeEvent));
const { ACTIONS } = HOST_CONCEPTS_MODULE;
const COMPOSITE_HOOKS = new Set([
  'preflight-router.cjs',
  'postflight-router.cjs',
  'prompt-context.cjs',
  'session-bootstrap.cjs',
  'stop-summary.cjs',
  'postflight-observer.cjs',
]);

function parseCommandLine(command) {
  const parts = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(command || '')) !== null) {
    parts.push(match[1] ?? match[2] ?? match[3]);
  }
  return parts;
}

function mergeHookConfigs(base, next) {
  const merged = { ...(base || {}) };
  const hooks = { ...(merged.hooks || {}) };
  for (const [point, entries] of Object.entries(next?.hooks || {})) {
    hooks[point] = [...(hooks[point] || []), ...(Array.isArray(entries) ? entries : [])];
  }
  merged.hooks = hooks;
  return merged;
}

function readSettingsFiles(files = DEFAULT_SETTINGS_FILES) {
  let config = {};
  const loadedFiles = [];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    config = mergeHookConfigs(config, parsed);
    loadedFiles.push(file);
  }
  return { config, loadedFiles };
}

/**
 * 插件 hooks.json 用 exec 形式（command:"node", args:[...]），settings.json 用整行命令。
 * 归一成命令行字符串，后续的 scriptRefsForCommand / manifest 交叉核对不必区分来源。
 */
function hookCommandLine(hook) {
  const command = hook.command || hook.run || '';
  if (!command) return '';
  const args = Array.isArray(hook.args) ? hook.args : [];
  if (!args.length) return command;
  return [command, ...args.map(arg => (/\s/.test(String(arg)) ? `"${arg}"` : String(arg)))].join(' ');
}

function appendHookEntries(entries, hooks, source) {
  for (const [point, groups] of Object.entries(hooks || {})) {
    const arr = Array.isArray(groups) ? groups : [];
    for (const [groupIndex, group] of arr.entries()) {
      const hookList = Array.isArray(group.hooks) ? group.hooks : [group];
      for (const [hookIndex, hook] of hookList.entries()) {
        const command = hookCommandLine(hook);
        if (!command) continue;
        entries.push({
          point,
          matcher: group.matcher || hook.matcher || '*',
          command,
          id: hook.id || group.id || command.slice(0, 80),
          isAsync: Boolean(hook.async || group.async),
          groupIndex,
          hookIndex,
          source,
          raw: hook,
        });
      }
    }
  }
  return entries;
}

/**
 * 插件来源默认关闭 —— 只读 settings 文件是历史行为。
 * 通过 opts.includePlugin 或 env CLAUDE_HARNESS_REGISTRY_INCLUDE_PLUGIN=1 打开。
 */
function pluginSourceEnabled(opts = {}) {
  if (typeof opts.includePlugin === 'boolean') return opts.includePlugin;
  return String(process.env.CLAUDE_HARNESS_REGISTRY_INCLUDE_PLUGIN || '') === '1';
}

/**
 * 读取入库的 core/engine/hooks/plugin.hooks.json，把 ${CLAUDE_PLUGIN_ROOT} 展开为 root。
 * 文件缺失不是错误（未渲染的克隆），返回空 hooks。
 */
function readPluginHooks(opts = {}) {
  const root = opts.root || HOME;
  const file = opts.pluginPath || path.join(root, PLUGIN_HOOKS_RELATIVE_PATH);
  if (!fs.existsSync(file)) return { hooks: {}, file: null };
  const raw = fs.readFileSync(file, 'utf8')
    .replace(PLUGIN_ROOT_PLACEHOLDER, String(root).replace(/\\/g, '/').replace(/\/+$/, ''));
  const parsed = JSON.parse(raw);
  return { hooks: parsed.hooks || {}, file };
}

function collectHookEntries(opts = {}) {
  const files = opts.files || settingsFiles(opts.root || HOME);
  const { config } = opts.config ? { config: opts.config } : readSettingsFiles(files);
  const entries = [];

  appendHookEntries(entries, config.hooks || {}, 'settings');

  if (pluginSourceEnabled(opts)) {
    const { hooks } = readPluginHooks({ root: opts.root || HOME, pluginPath: opts.pluginPath });
    appendHookEntries(entries, hooks, 'plugin');
  }

  return entries;
}

function harnessRelativeParts(arg) {
  const normalized = String(arg || '').replace(/\\/g, '/');
  const lower = normalized.toLowerCase();
  // Phase 1.1 起命令指向 core/engine/...（新布局优先）；
  // 旧布局 /engine/... 保留兼容（快照逃生、拆层前检出）。
  const coreIndex = lower.lastIndexOf('/core/engine/');
  if (coreIndex >= 0) {
    return normalized.slice(coreIndex + 1).split('/').filter(Boolean);
  }
  const marker = '/engine/';
  const markerIndex = lower.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  return normalized.slice(markerIndex + 1).split('/').filter(Boolean);
}

function resolveScriptArg(arg, root = HOME) {
  if (!arg || arg === '-e') return null;
  const relativeParts = harnessRelativeParts(arg);
  if (relativeParts) return path.join(root, ...relativeParts);
  return resolvePath(expandHome(arg), root);
}

function batchScriptsFromCommand(command, root = HOME) {
  const parts = parseCommandLine(command);
  const scripts = [];
  const batchIndex = parts.indexOf('--batch');
  if (batchIndex === -1 || !parts[batchIndex + 1]) return scripts;

  for (const name of parts[batchIndex + 1].split(',')) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    // Phase 1.1 起 batch 脚本位于 core/engine/scripts/hooks/；旧布局回退保留。
    const corePath = path.join(root, 'core', 'engine', 'scripts', 'hooks', trimmed);
    scripts.push(fs.existsSync(corePath)
      ? corePath
      : path.join(root, 'engine', 'scripts', 'hooks', trimmed));
  }
  return scripts;
}

function scriptRefsForCommand(command, opts = {}) {
  const root = opts.root || HOME;
  const parts = parseCommandLine(command);
  const refs = [];
  const batchScripts = batchScriptsFromCommand(command, root);

  for (let i = 0; i < parts.length; i++) {
    const token = parts[i];
    const base = path.basename(token || '').toLowerCase();
    if (base === 'node' || base === 'node.exe' || base === 'bash' || base === 'bash.exe') {
      const candidate = parts[i + 1];
      const script = resolveScriptArg(candidate, root);
      if (script && /\.(?:cjs|js|mjs|sh)$/i.test(script)) {
        refs.push({ script, source: candidate, kind: base.startsWith('node') ? 'node' : 'bash' });
      }
    }
  }

  for (const script of batchScripts) {
    refs.push({ script, source: path.basename(script), kind: 'batch' });
  }

  const seen = new Set();
  return refs.filter(ref => {
    const key = ref.script.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function localRequireRequests(source) {
  const requests = [];
  let mode = 'code';
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    const next = source[index + 1];
    if (mode === 'line-comment') {
      if (char === '\n' || char === '\r') mode = 'code';
      continue;
    }
    if (mode === 'block-comment') {
      if (char === '*' && next === '/') { mode = 'code'; index++; }
      continue;
    }
    if (mode !== 'code') {
      if (char === '\\') { index++; continue; }
      if ((mode === 'single' && char === "'")
          || (mode === 'double' && char === '"')
          || (mode === 'template' && char === '`')) mode = 'code';
      continue;
    }
    if (char === '/' && next === '/') { mode = 'line-comment'; index++; continue; }
    if (char === '/' && next === '*') { mode = 'block-comment'; index++; continue; }
    if (char === "'") { mode = 'single'; continue; }
    if (char === '"') { mode = 'double'; continue; }
    if (char === '`') { mode = 'template'; continue; }
    if (!source.startsWith('require', index)
        || /[A-Za-z0-9_$]/.test(source[index - 1] || '')) continue;
    const match = /^require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/.exec(source.slice(index));
    if (!match) continue;
    requests.push(match[1]);
    index += match[0].length - 1;
  }
  return requests;
}

function resolveStaticRequest(parentScript, request) {
  let resolved = path.resolve(path.dirname(parentScript), request);
  if (!path.extname(resolved)) {
    if (fs.existsSync(`${resolved}.cjs`)) resolved = `${resolved}.cjs`;
    else if (fs.existsSync(`${resolved}.js`)) resolved = `${resolved}.js`;
    else if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      if (fs.existsSync(path.join(resolved, 'index.cjs'))) resolved = path.join(resolved, 'index.cjs');
      else if (fs.existsSync(path.join(resolved, 'index.js'))) resolved = path.join(resolved, 'index.js');
    }
  }
  return resolved;
}

function staticRouterDependencies(script) {
  if (!COMPOSITE_HOOKS.has(path.basename(script).toLowerCase()) || !fs.existsSync(script)) return [];
  const refs = [];
  const seen = new Set([path.resolve(script).toLowerCase()]);

  function visit(parentScript) {
    if (!fs.existsSync(parentScript)) return;
    const source = fs.readFileSync(parentScript, 'utf8');
    for (const request of localRequireRequests(source)) {
      const resolved = resolveStaticRequest(parentScript, request);
      const key = resolved.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({
        script: resolved,
        source: request,
        parent: parentScript,
        kind: 'router-dependency',
      });
      visit(resolved);
    }
  }

  visit(path.resolve(script));
  return refs;
}

function validateHookScripts(opts = {}) {
  const root = opts.root || HOME;
  const entries = collectHookEntries(opts);
  const missing = [];
  const found = [];

  for (const entry of entries) {
    const refs = scriptRefsForCommand(entry.command, { root });
    for (const ref of refs) {
      const record = { ...ref, point: entry.point, matcher: entry.matcher, command: entry.command };
      if (fs.existsSync(ref.script)) {
        found.push(record);
        for (const dependency of staticRouterDependencies(ref.script)) {
          const dependencyRecord = {
            ...dependency,
            point: entry.point,
            matcher: entry.matcher,
            command: entry.command,
          };
          if (fs.existsSync(dependency.script)) found.push(dependencyRecord);
          else missing.push(dependencyRecord);
        }
      } else missing.push(record);
    }
  }

  return { entries, found, missing };
}

function normalizedRelative(root, target) {
  return path.relative(path.resolve(root), path.resolve(target)).replace(/\\/g, '/');
}

function loadHookManifest(opts = {}) {
  const root = path.resolve(opts.root || HOME);
  const manifestPath = path.resolve(opts.path || path.join(root, MANIFEST_RELATIVE_PATH));
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

function validateHookManifest(opts = {}) {
  const root = path.resolve(opts.root || HOME);
  const manifest = opts.manifest || loadHookManifest({ root, path: opts.manifestPath });
  const registrations = collectHookEntries({
    root,
    ...(opts.files ? { files: opts.files } : {}),
    ...(opts.config ? { config: opts.config } : {}),
    ...(typeof opts.includePlugin === 'boolean' ? { includePlugin: opts.includePlugin } : {}),
    ...(opts.pluginPath ? { pluginPath: opts.pluginPath } : {}),
  });
  const errors = [];
  const declared = new Map();
  const activeScripts = new Set();
  const requiredFields = [
    'script', 'kind', 'events', 'tools', 'payloadSchema', 'blocking',
    'sideEffects', 'timeoutSeconds', 'owner', 'fixture', 'active',
  ];

  if (manifest?.version !== 2 && manifest?.version !== 3) {
    errors.push(`unsupported hook manifest version: ${manifest?.version}`);
  }
  if (!Array.isArray(manifest?.entries)) {
    return { checked: 0, errors: [...errors, 'hook manifest entries must be an array'], manifest, registrations };
  }
  if (!Array.isArray(manifest?.consumerRegistry)) {
    errors.push('hook manifest consumerRegistry must be an array');
  }

  for (const entry of manifest.entries) {
    const label = String(entry?.script || '<unknown>');
    for (const field of requiredFields) {
      if (!Object.hasOwn(entry || {}, field)) errors.push(`${label} missing ${field}`);
    }
    if (!Array.isArray(entry?.events) || entry.events.length === 0) errors.push(`${label} events must be non-empty`);
    if (!Array.isArray(entry?.tools) || entry.tools.length === 0) errors.push(`${label} tools must be non-empty`);
    if (!Array.isArray(entry?.sideEffects)) errors.push(`${label} sideEffects must be an array`);
    if (typeof entry?.blocking !== 'boolean') errors.push(`${label} blocking must be boolean`);
    if (typeof entry?.active !== 'boolean') errors.push(`${label} active must be boolean`);
    if (!Number.isFinite(entry?.timeoutSeconds) || entry.timeoutSeconds <= 0) {
      errors.push(`${label} timeoutSeconds must be positive`);
    }
    if (!entry?.payloadSchema || typeof entry.payloadSchema !== 'string') {
      errors.push(`${label} payloadSchema must be a string`);
    }
    // v3 增补字段（只增不改）：timeoutOverrides / action / 通道声明 / hostPresets。
    if (manifest?.version === 3) {
      if (entry.timeoutOverrides !== undefined) {
        if (!Array.isArray(entry.timeoutOverrides) || entry.timeoutOverrides.length === 0) {
          errors.push(`${label} timeoutOverrides must be a non-empty array when present`);
        } else {
          for (const ov of entry.timeoutOverrides) {
            if (!ov || typeof ov.event !== 'string' || !entry.events.includes(ov.event)) {
              errors.push(`${label} timeoutOverrides references unknown event: ${ov?.event}`);
            }
            if (!Number.isFinite(ov?.timeoutSeconds) || ov.timeoutSeconds <= 0) {
              errors.push(`${label} timeoutOverrides ${ov?.event} timeoutSeconds must be positive`);
            }
          }
        }
      }
      if (entry.action !== undefined) {
        const actions = Array.isArray(entry.action) ? entry.action : [entry.action];
        for (const a of actions) {
          if (!ACTIONS.includes(a)) errors.push(`${label} action not in §3.7 word list: ${a}`);
        }
      }
      if (entry.blockChannel !== undefined && !['exit_code_2', 'json_decision', 'none'].includes(entry.blockChannel)) {
        errors.push(`${label} blockChannel must be exit_code_2|json_decision|none`);
      }
      if (entry.injectChannel !== undefined && !['additionalContext', 'stdout', 'none'].includes(entry.injectChannel)) {
        errors.push(`${label} injectChannel must be additionalContext|stdout|none`);
      }
      if (entry.toolMatcher !== undefined && !['*', 'capability'].includes(entry.toolMatcher)) {
        errors.push(`${label} toolMatcher must be *|capability`);
      }
    }
    if (!entry?.owner || typeof entry.owner !== 'string') errors.push(`${label} owner must be a string`);
    if (!entry?.fixture || !fs.existsSync(path.resolve(root, entry.fixture))) {
      errors.push(`${label} fixture is missing: ${entry?.fixture || '<none>'}`);
    }

    const key = label.replace(/\\/g, '/').toLowerCase();
    if (declared.has(key)) errors.push(`duplicate hook manifest entry: ${label}`);
    else declared.set(key, entry);
  }

  const consumers = new Map();
  for (const consumer of manifest.consumerRegistry || []) {
    const id = String(consumer?.id || '').trim();
    const label = id || '<unknown-consumer>';
    for (const field of [
      'id', 'kind', 'event', 'hostScript', 'component', 'requiresWatermark',
      'requiresHeartbeat', 'timeoutSeconds', 'active',
    ]) {
      if (!Object.hasOwn(consumer || {}, field)) errors.push(`${label} consumer missing ${field}`);
    }
    if (!id) errors.push('consumer id must be a non-empty string');
    if (consumers.has(id)) errors.push(`duplicate consumer registry entry: ${id}`);
    else if (id) consumers.set(id, consumer);
    if (!['event-stream', 'policy'].includes(consumer?.kind)) {
      errors.push(`${label} consumer kind must be event-stream or policy`);
    }
    if (!consumer?.event || typeof consumer.event !== 'string') {
      errors.push(`${label} consumer event must be a string`);
    }
    if (!consumer?.hostScript || typeof consumer.hostScript !== 'string') {
      errors.push(`${label} consumer hostScript must be a string`);
    }
    if (!consumer?.component || typeof consumer.component !== 'string') {
      errors.push(`${label} consumer component must be a string`);
    }
    if (typeof consumer?.requiresWatermark !== 'boolean') {
      errors.push(`${label} consumer requiresWatermark must be boolean`);
    }
    if (typeof consumer?.requiresHeartbeat !== 'boolean') {
      errors.push(`${label} consumer requiresHeartbeat must be boolean`);
    }
    if (!Number.isFinite(consumer?.timeoutSeconds) || consumer.timeoutSeconds <= 0) {
      errors.push(`${label} consumer timeoutSeconds must be positive`);
    }
    if (typeof consumer?.active !== 'boolean') errors.push(`${label} consumer active must be boolean`);
    if (consumer?.kind === 'event-stream') {
      for (const field of ['minBatch', 'maxBatch', 'maxPendingAgeSeconds']) {
        if (!Number.isFinite(consumer?.[field]) || consumer[field] < 0) {
          errors.push(`${label} consumer ${field} must be non-negative`);
        }
      }
      if (Number.isFinite(consumer?.minBatch) && Number.isFinite(consumer?.maxBatch)
          && consumer.minBatch > consumer.maxBatch) {
        errors.push(`${label} consumer minBatch cannot exceed maxBatch`);
      }
    }

    if (consumer?.active === true && consumer?.hostScript) {
      const hostKey = String(consumer.hostScript).replace(/\\/g, '/').toLowerCase();
      const host = declared.get(hostKey);
      if (!host || host.active !== true) {
        errors.push(`${label} consumer host is not an active manifest entry: ${consumer.hostScript}`);
      } else {
        if (!host.events.includes(consumer.event)) {
          errors.push(`${label} consumer event ${consumer.event} is not supported by ${consumer.hostScript}`);
        }
        if (!Array.isArray(host.consumers) || !host.consumers.includes(id)) {
          errors.push(`${label} consumer is not linked from host entry ${consumer.hostScript}`);
        }
      }
    }
  }

  for (const entry of manifest.entries) {
    for (const id of entry.consumers || []) {
      const consumer = consumers.get(id);
      if (!consumer || consumer.active !== true) {
        errors.push(`${entry.script} links unknown or inactive consumer: ${id}`);
        continue;
      }
      const entryKey = String(entry.script || '').replace(/\\/g, '/').toLowerCase();
      const hostKey = String(consumer.hostScript || '').replace(/\\/g, '/').toLowerCase();
      if (entryKey !== hostKey) errors.push(`${entry.script} is not the declared host for consumer ${id}`);
    }
  }

  let checked = 0;
  for (const registration of registrations) {
    const primary = scriptRefsForCommand(registration.command, { root })
      .find(ref => ref.kind !== 'batch');
    if (!primary) continue;
    checked++;
    const relative = normalizedRelative(root, primary.script);
    const key = relative.toLowerCase();
    const declaration = declared.get(key);
    if (!declaration || declaration.active !== true) {
      errors.push(`${registration.point} ${registration.matcher}: active hook is not declared: ${relative}`);
      continue;
    }
    activeScripts.add(key);
    if (!declaration.events.includes(registration.point)) {
      errors.push(`${registration.point} ${registration.matcher}: ${relative} does not support this event`);
    }
    if (TOOL_EVENTS.has(registration.point) && !declaration.tools.includes('*')) {
      const registeredTools = String(registration.matcher || '*').split('|').map(value => value.trim()).filter(Boolean);
      for (const tool of registeredTools) {
        if (!declaration.tools.includes(tool)) {
          errors.push(`${registration.point} ${registration.matcher}: ${relative} does not support tool ${tool}`);
        }
      }
    }
    const configuredTimeout = Number(registration.raw?.timeout);
    if (Number.isFinite(configuredTimeout) && configuredTimeout > declaration.timeoutSeconds) {
      errors.push(`${registration.point} ${registration.matcher}: ${relative} timeout ${configuredTimeout}s exceeds manifest ${declaration.timeoutSeconds}s`);
    }
    // v3 双向交叉校验：注册超时若与 manifest timeoutSeconds 不同，必须被
    // timeoutOverrides 精确声明（per-event 实况表——派生 registrations 的输入真源）。
    if (manifest?.version === 3 && Number.isFinite(configuredTimeout)
        && configuredTimeout !== declaration.timeoutSeconds) {
      const ov = (declaration.timeoutOverrides || [])
        .find((o) => o.event === registration.point);
      if (!ov) {
        errors.push(`${registration.point}: ${relative} registered timeout ${configuredTimeout}s differs from manifest ${declaration.timeoutSeconds}s but has no timeoutOverrides entry`);
      } else if (ov.timeoutSeconds !== configuredTimeout) {
        errors.push(`${registration.point}: ${relative} timeoutOverrides declares ${ov.timeoutSeconds}s but registration says ${configuredTimeout}s`);
      }
    }
  }

  for (const [key, entry] of declared) {
    if (entry.active === true && !activeScripts.has(key)) {
      errors.push(`manifest marks an unregistered hook active: ${entry.script}`);
    }
  }

  return { checked, errors, manifest, registrations };
}

module.exports = {
  HOME,
  DEFAULT_SETTINGS_FILES,
  MANIFEST_RELATIVE_PATH,
  PLUGIN_HOOKS_RELATIVE_PATH,
  COMPOSITE_HOOKS,
  parseCommandLine,
  hookCommandLine,
  pluginSourceEnabled,
  readPluginHooks,
  harnessRelativeParts,
  batchScriptsFromCommand,
  mergeHookConfigs,
  readSettingsFiles,
  collectHookEntries,
  scriptRefsForCommand,
  localRequireRequests,
  resolveStaticRequest,
  staticRouterDependencies,
  validateHookScripts,
  loadHookManifest,
  validateHookManifest,
};
