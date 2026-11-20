'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');
const { parseArgs } = require('node:util');

const root = path.resolve(__dirname, '../..');
const market = 'agent-harness-logic';
const pluginId = 'logical-paradox@' + market;
const scripts = path.join(root, 'core/engine/scripts');
const catalogPath = '.agents/plugins/marketplace.json';

function run(file, args, capture = false) {
  const result = spawnSync(file, args, { cwd: root, encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', windowsHide: capture });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr?.trim() || file + ' exited with ' + (result.signal || result.status));
  return result.stdout;
}

function findCli() {
  if (process.platform !== 'win32') return ['codex'];
  // npm's JS entry can inherit a terminal and exchange JSON over pipes without cmd.exe quoting.
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const entry = path.join(dir, 'node_modules/@openai/codex/bin/codex.js');
    if (fs.existsSync(path.join(dir, 'codex.cmd')) && fs.existsSync(entry)) return [process.execPath, entry];
    if (fs.existsSync(path.join(dir, 'codex.exe'))) return [path.join(dir, 'codex.exe')];
  }
  const location = run('powershell.exe', ['-NoProfile', '-Command',
    '(Get-AppxPackage -Name OpenAI.Codex).InstallLocation'], true).trim();
  const exe = path.join(location, 'app/resources/codex.exe');
  if (location && fs.existsSync(exe)) return [exe];
  throw new Error('Install Codex CLI with npm.cmd install -g @openai/codex, then retry.');
}

function reinstallVersion({ cache, codexHome, version, pkg, install }) {
  const pluginHome = fs.realpathSync(path.join(codexHome, 'plugins'));
  const expected = path.join(pluginHome, 'cache', market, 'logical-paradox', version);
  if (!/^[a-z\d][\w.-]*$/i.test(version) || path.relative(expected, fs.realpathSync(cache)) !== '') {
    throw new Error('Unexpected installed plugin cache: ' + cache);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(cache, '.codex-plugin/plugin.json'), 'utf8'));
  if (manifest.name !== 'logical-paradox' || manifest.version !== version) throw new Error('Unexpected cache manifest');
  const { filesIn, differences } = require(path.join(scripts, 'sync-plugin-dist.cjs'));
  const stage = path.join(pluginHome, '.logical-paradox-refresh-' + version);
  fs.mkdirSync(stage); // Exclusive across concurrent recovery attempts. A retained directory contains recovery data.
  const previous = path.join(stage, 'previous');
  try {
    fs.renameSync(cache, previous);
    install();
    if (differences(filesIn(pkg), filesIn(cache)).length) throw new Error('Native reinstall produced a different package');
  } catch (error) {
    if (fs.existsSync(previous)) {
      if (fs.existsSync(cache)) throw new Error(error.message + '. Previous version retained at ' + previous);
      fs.renameSync(previous, cache);
    }
    fs.rmdirSync(stage);
    throw error;
  }
  fs.rmSync(stage, { recursive: true, force: true });
}

async function request([file, ...prefix], method, params) {
  const child = spawn(file, [...prefix, 'app-server', '--stdio'], { cwd: root, windowsHide: true });
  const lines = readline.createInterface({ input: child.stdout });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-1500); });
  const send = message => child.stdin.write(JSON.stringify(message) + '\n');
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Codex timed out: ' + method)), 45000);
      child.once('error', reject);
      child.stdin.on('error', reject);
      child.once('close', code => reject(new Error(stderr || 'Codex closed before ' + method + ': ' + code)));
      lines.on('line', line => {
        try {
          const msg = JSON.parse(line);
          if (msg.error) throw new Error(msg.error.message);
          if (msg.id === 1) {
            send({ method: 'initialized' });
            send({ id: 2, method, params });
          }
          if (msg.id === 2) resolve(msg.result);
        } catch (error) { reject(error); }
      });
      send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'harness_connect', version: '1' },
        capabilities: { experimentalApi: true } } });
    });
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    lines.close();
    child.kill();
  }
}

async function readHooks(cli) {
  const result = await request(cli, 'hooks/list', { cwds: [root] });
  const entry = result.data.find(item => path.relative(root, item.cwd) === '');
  if (!entry || entry.errors?.length) throw new Error('Invalid hook inventory: ' + JSON.stringify(entry?.errors));
  for (const warning of entry.warnings || []) console.warn(warning);
  return entry.hooks;
}

function duplicates(hooks) {
  const users = hooks.filter(h => h.source === 'user' && h.handlerType === 'command' && h.enabled && !h.isManaged);
  const found = new Set();
  for (const p of hooks.filter(h => h.pluginId === pluginId && h.enabled && h.trustStatus === 'trusted')) {
    const command = /^node "(?:\$env:PLUGIN_ROOT|\$\{PLUGIN_ROOT\})\/([\w./-]+\.cjs)"(.*?)(?:; exit \$LASTEXITCODE)?$/.exec(p.command);
    if (!command || command[1].split('/').includes('..')) continue;
    const [, script, args] = command;
    const pkg = path.resolve(path.dirname(p.sourcePath), '..');
    const sameFile = rel => fs.existsSync(path.join(root, rel)) && fs.existsSync(path.join(pkg, rel)) &&
      fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n') === fs.readFileSync(path.join(pkg, rel), 'utf8').replace(/\r\n/g, '\n');
    if (!sameFile(script)) continue;
    const equivalents = [[script, args, p.timeoutSec]];
    const legacy = {
      'core/engine/scripts/context-resume.cjs': ['sessionStart', ' --session-start', ''],
      'core/engine/scripts/state-resume.cjs': ['sessionStart', ' --session-start', ''],
      'core/engine/scripts/dream-startup-inject.cjs': ['sessionStart', ' --session-start', ''],
      'core/engine/scripts/pre-compact.cjs': ['preCompact', ' --quiet', ''],
      'core/engine/scripts/memory-knowledge-maintenance.cjs': ['sessionStart', ' --auto --execute --quiet', ' --auto --execute'],
      'core/engine/hooks/git/git-integrity-guard.cjs': ['stop', ' --workspace', ''],
    }[script];
    if (legacy && p.eventName === legacy[0] && args === legacy[1]) equivalents.push([script, legacy[2], p.timeoutSec]);
    // The context adapter replaced these two default-timeout PreToolUse commands.
    if (p.eventName === 'preToolUse' && script === 'hosts/codex/patch-hook.cjs' && args === ' context' &&
        sameFile('core/engine/scripts/hooks/prompt-context.cjs')) {
      for (const name of ['rule-loader', 'memory-retrieve-hook']) {
        const rel = 'core/engine/scripts/' + name + '.cjs';
        if (sameFile(rel)) equivalents.push([rel, '', 600]);
      }
    }
    for (const [rel, suffix, timeout] of equivalents) {
      const target = path.join(root, rel).replaceAll('\\', '/');
      for (const u of users) {
        const cmd = u.command.replaceAll('\\', '/');
        if (u.eventName === p.eventName && u.matcher === p.matcher && u.async === p.async &&
            u.timeoutSec === timeout && u.additionalContextLimit === p.additionalContextLimit &&
            (cmd === 'node "' + target + '"' + suffix || (!/\s/.test(target) && cmd === 'node ' + target + suffix))) found.add(u);
      }
    }
  }
  return [...found];
}

function summarize(hooks, expected) {
  const ours = hooks.filter(h => h.pluginId === pluginId);
  if (!expected || ours.length !== expected) throw new Error(`Codex loaded ${ours.length} of ${expected} expected plugin hooks`);
  const approved = h => ['trusted', 'managed'].includes(h.trustStatus);
  const pending = ours.filter(h => h.enabled && !approved(h)).length;
  const disabled = ours.filter(h => !h.enabled).length;
  // The native bulk-review dialog can include disabled definitions from other sources.
  const otherPending = hooks.filter(h => h.pluginId !== pluginId && !approved(h)).length;
  console.log(`${pluginId}: ${ours.length - pending - disabled}/${expected} enabled and trusted, ${pending} need review, ${disabled} disabled.`);
  return { pending, disabled, otherPending };
}

async function main() {
  const { values } = parseArgs({ options: { check: { type: 'boolean' }, refresh: { type: 'boolean' }, dedupe: { type: 'boolean' } } });
  if (values.check && (values.refresh || values.dedupe)) throw new Error('--check is read-only.');
  const cli = findCli();
  const codex = (args, capture = false) => run(cli[0], [...cli.slice(1), ...args], capture);
  const hooksFile = path.join(root, 'dist/plugin/hooks/codex.json');
  if (!values.check && (!fs.existsSync(hooksFile) || values.refresh)) run(process.execPath, [path.join(scripts, 'sync-plugin-dist.cjs')]);
  const catalog = JSON.parse(fs.readFileSync(path.join(root, catalogPath), 'utf8'));
  const source = catalog.plugins.find(p => p.name === 'logical-paradox')?.source;
  if (source?.source !== 'local' || source.path !== './dist/plugin') throw new Error('Unexpected Codex marketplace source');
  const groups = JSON.parse(fs.readFileSync(hooksFile, 'utf8')).hooks;
  const expected = Object.values(groups).flat().reduce((n, group) => n + group.hooks.length, 0);
  const markets = JSON.parse(codex(['plugin', 'marketplace', 'list', '--json'], true)).marketplaces;
  const registered = markets.find(item => item.name === market);
  if (registered && fs.realpathSync(registered.root) !== fs.realpathSync(root)) {
    throw new Error(market + ' already points to another checkout: ' + registered.root);
  }
  if (!registered) {
    if (values.check) throw new Error('Marketplace is not registered: ' + market);
    codex(['plugin', 'marketplace', 'add', root]);
  }
  const version = JSON.parse(fs.readFileSync(path.join(root, 'dist/plugin/.codex-plugin/plugin.json'), 'utf8')).version;
  const installed = () => JSON.parse(codex(['plugin', 'list', '--marketplace', market, '--json'], true)).installed
    .some(p => p.pluginId === pluginId && p.enabled && p.version === version && p.source?.source === 'local' &&
      fs.realpathSync(p.source.path) === fs.realpathSync(path.join(root, 'dist/plugin')));
  let ready = installed();
  let refreshNeeded = false;
  let cached;
  if (ready && values.refresh) {
    // Reinstalling even an identical package can clear Codex's recorded hook trust.
    const { filesIn, differences } = require(path.join(scripts, 'sync-plugin-dist.cjs'));
    const hook = (await readHooks(cli)).find(h => h.pluginId === pluginId);
    cached = hook && path.resolve(path.dirname(hook.sourcePath), '..');
    refreshNeeded = !cached || differences(filesIn(path.join(root, 'dist/plugin')), filesIn(cached)).length > 0;
  }
  if (!values.check && (refreshNeeded || !ready)) {
    const install = () => {
      const output = codex(['plugin', 'add', pluginId], true);
      if (output.trim()) console.log(output.trim());
    };
    try {
      install();
    } catch (error) {
      if (process.platform !== 'win32' || !cached || !refreshNeeded ||
          !/failed to back up plugin cache entry/i.test(error.message)) throw error;
      reinstallVersion({ cache: cached, codexHome: process.env.CODEX_HOME || path.join(require('node:os').homedir(), '.codex'),
        version, pkg: path.join(root, 'dist/plugin'), install });
    }
    ready = installed();
  }
  if (!ready) {
    throw new Error('Expected enabled plugin from the local dist/plugin: ' + pluginId);
  }
  run(process.execPath, [path.join(scripts, 'install-codex-plugin-profile.cjs'), ...(values.check ? ['--check'] : [])]);
  let hooks = await readHooks(cli);
  let status = summarize(hooks, expected);
  if (!values.check && (status.pending || status.disabled) && process.stdin.isTTY && process.stdout.isTTY) {
    if (status.pending && !status.otherPending) console.log('Only this plugin needs review. Codex offers "Trust all and continue".');
    if (status.otherPending) console.log('Other sources also need review. Choose "Review hooks" and select only ' + pluginId + '.');
    console.log('Use /hooks for individual entries. Exit Codex with /quit to verify the result.');
    // Hook approval is a local Codex operation. An unavailable account route must not prevent review.
    const review = ['--no-daemon', '-C', root,
      '-c', 'model_provider="harness_review"',
      '-c', 'model_providers.harness_review.name="Local hook review"',
      '-c', 'model_providers.harness_review.base_url="http://127.0.0.1:9/v1"',
      '-c', 'model_providers.harness_review.wire_api="responses"'];
    const catalogFile = path.join(process.env.CODEX_HOME || path.join(require('node:os').homedir(), '.codex'), 'models_cache.json');
    if (fs.existsSync(catalogFile)) review.push('-c', 'model_catalog_json=' + JSON.stringify(catalogFile.replaceAll('\\', '/')));
    console.log('This local review session is for /hooks and /quit. Model calls are disabled.');
    codex(review);
    hooks = await readHooks(cli);
    status = summarize(hooks, expected);
  }
  if (status.pending || status.disabled) {
    console.error('Hook setup is pending. Run npm run codex:connect in an interactive terminal.');
    process.exitCode = 2;
    return;
  }
  const old = duplicates(hooks);
  if (old.length && !values.dedupe) {
    console.warn(old.length + ' overlapping User hooks. To disable these, run npm run codex:connect -- --dedupe');
  } else if (old.length) {
    const cfg = await request(cli, 'config/read', { includeLayers: true, cwd: root });
    const user = cfg.layers?.find(layer => layer.name.type === 'user');
    if (!user?.version) throw new Error('Could not identify user config version for updating hook switches.');
    const current = duplicates(await readHooks(cli));
    const approved = new Map(old.map(h => [h.key, h.currentHash]));
    if (current.length !== old.length || current.some(h => approved.get(h.key) !== h.currentHash)) {
      throw new Error('Hook definitions changed. Run the command again.');
    }
    await request(cli, 'config/batchWrite', { expectedVersion: user.version, filePath: user.name.file,
      edits: current.map(h => ({ keyPath: 'hooks.state.' + JSON.stringify(h.key) + '.enabled', value: false, mergeStrategy: 'replace' })) });
    const after = await readHooks(cli);
    if (current.some(h => !after.some(a => a.key === h.key && a.enabled === false && a.currentHash === h.currentHash))) {
      throw new Error('Codex did not confirm all requested user-hook switches.');
    }
    console.log('Disabled ' + old.length + ' verified overlapping User hooks.');
  }
}

if (require.main === module) {
  main().catch(error => { console.error('[codex:connect] ' + error.message); process.exitCode = 1; });
}
module.exports = { duplicates, catalogPath, reinstallVersion };
