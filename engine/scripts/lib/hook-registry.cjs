'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { expandHome, resolvePath } = require('./project-scope.cjs');

const HOME = path.join(os.homedir(), '.claude');
const DEFAULT_SETTINGS_FILES = [
  path.join(HOME, 'settings.json'),
  path.join(HOME, 'settings.local.json'),
];

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

function collectHookEntries(opts = {}) {
  const { config } = opts.config ? { config: opts.config } : readSettingsFiles(opts.files);
  const hooks = config.hooks || {};
  const entries = [];

  for (const [point, groups] of Object.entries(hooks)) {
    const arr = Array.isArray(groups) ? groups : [];
    for (const [groupIndex, group] of arr.entries()) {
      const hookList = Array.isArray(group.hooks) ? group.hooks : [group];
      for (const [hookIndex, hook] of hookList.entries()) {
        const command = hook.command || hook.run || '';
        if (!command) continue;
        entries.push({
          point,
          matcher: group.matcher || hook.matcher || '*',
          command,
          id: hook.id || group.id || command.slice(0, 80),
          isAsync: Boolean(hook.async || group.async),
          groupIndex,
          hookIndex,
          raw: hook,
        });
      }
    }
  }

  return entries;
}

function resolveScriptArg(arg) {
  if (!arg || arg === '-e') return null;
  return resolvePath(expandHome(arg), HOME);
}

function batchScriptsFromCommand(command) {
  const parts = parseCommandLine(command);
  const scripts = [];
  const batchIndex = parts.indexOf('--batch');
  if (batchIndex === -1 || !parts[batchIndex + 1]) return scripts;

  for (const name of parts[batchIndex + 1].split(',')) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    scripts.push(path.join(HOME, 'engine', 'scripts', 'hooks', trimmed));
  }
  return scripts;
}

function scriptRefsForCommand(command) {
  const parts = parseCommandLine(command);
  const refs = [];
  const batchScripts = batchScriptsFromCommand(command);

  for (let i = 0; i < parts.length; i++) {
    const token = parts[i];
    const base = path.basename(token || '').toLowerCase();
    if (base === 'node' || base === 'node.exe' || base === 'bash' || base === 'bash.exe') {
      const candidate = parts[i + 1];
      const script = resolveScriptArg(candidate);
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

function validateHookScripts(opts = {}) {
  const entries = collectHookEntries(opts);
  const missing = [];
  const found = [];

  for (const entry of entries) {
    const refs = scriptRefsForCommand(entry.command);
    for (const ref of refs) {
      const record = { ...ref, point: entry.point, matcher: entry.matcher, command: entry.command };
      if (fs.existsSync(ref.script)) found.push(record);
      else missing.push(record);
    }
  }

  return { entries, found, missing };
}

module.exports = {
  HOME,
  DEFAULT_SETTINGS_FILES,
  parseCommandLine,
  mergeHookConfigs,
  readSettingsFiles,
  collectHookEntries,
  scriptRefsForCommand,
  validateHookScripts,
};
