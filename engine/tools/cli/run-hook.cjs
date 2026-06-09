const fs = require('fs');
const path = require('path');
const { findProjectRoot } = require('../../lib/utils/project-root.cjs');
const eventBus = require('../../lib/events/event-bus.cjs');
const { dispatchExitCode } = require('../../lib/routing/hook-exit-dispatcher.cjs');

function detectProjectRoot(cwd = process.cwd()) {
  const fromCwd = findProjectRoot(cwd);
  if (fs.existsSync(path.join(fromCwd, '.claude', 'hooks'))) {
    return fromCwd;
  }

  const fromScript = findProjectRoot(path.resolve(__dirname, '..', '..'));
  if (fs.existsSync(path.join(fromScript, '.claude', 'hooks'))) {
    return fromScript;
  }

  return path.resolve(__dirname, '..', '..');
}

function resolveHookScriptPath(hookName, projectRoot = detectProjectRoot()) {
  const hooksDir = path.join(projectRoot, '.claude', 'hooks');
  let scriptPath = path.resolve(hooksDir, hookName);

  if (!fs.existsSync(scriptPath)) {
    if (fs.existsSync(scriptPath + '.cjs')) {
      scriptPath += '.cjs';
    } else if (fs.existsSync(scriptPath + '.js')) {
      scriptPath += '.js';
    } else if (fs.existsSync(scriptPath + '.mjs')) {
      scriptPath += '.mjs';
    } else if (fs.existsSync(scriptPath + '.sh')) {
      scriptPath += '.sh';
    }
  }

  return { scriptPath, hooksDir, projectRoot };
}

function buildHookEnv(baseEnv = process.env) {
  const context = eventBus.getContext ? eventBus.getContext() : { traceId: null };
  const traceId = String(baseEnv.CLAUDE_TRACE_ID || context.traceId || '').trim();
  if (!traceId) return { ...baseEnv };
  return {
    ...baseEnv,
    CLAUDE_TRACE_ID: traceId,
    HOOK_TRACE_ID: traceId,
  };
}

function loadHookConfig(projectRoot) {
  const configPath = path.join(projectRoot, '.claude', 'hooks', 'hook-config.json');
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf8');
      return JSON.parse(raw);
    }
  } catch (_err) {
    // Config file is optional, ignore errors
  }
  return { hooks: {} };
}

function isHookEnabled(hookName, config) {
  // Normalize hook name to relative path (e.g., "routing/foo.cjs")
  const normalized = hookName.replace(/\\/g, '/').replace(/^.*hooks\//, '');
  const hookConfig = config.hooks[normalized];
  if (!hookConfig) return true; // Default to enabled if not in config
  return hookConfig.enabled !== false;
}

function main() {
  // 1. Parse arguments
  // node run-hook.cjs <hook-name> [args...]
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: node run-hook.cjs <hook-path> [args...]');
    process.exit(2);
  }

  const hookName = args[0];
  const hookArgs = args.slice(1);
  const { scriptPath, hooksDir, projectRoot } = resolveHookScriptPath(hookName);

  if (!fs.existsSync(scriptPath)) {
    console.error(`Error: Hook not found: ${scriptPath}`);
    console.error(`Searched in: ${hooksDir}`);
    process.exit(2);
  }

  // 2. Check if hook is enabled via config
  const config = loadHookConfig(projectRoot);
  if (!isHookEnabled(hookName, config)) {
    // Hook is disabled, exit silently with success
    if (process.env.HOOK_DEBUG === 'true') {
      console.error(`[run-hook] Hook disabled via config: ${hookName}`);
    }
    process.exit(0);
  }

  // 3. Execute
  const HookRunner = require('../../lib/utils/hook-runner.cjs');
  const runner = new HookRunner({ projectRoot, env: buildHookEnv(process.env) });

  // Capture stderr for exit-code dispatcher (codes 3/4 need stderr for trailer parsing)
  const taskId = process.env.CLAUDE_TASK_ID || process.env.TASK_ID || null;

  runner
    .runProcess(scriptPath, hookArgs, { captureStderr: true })
    .then(result => {
      const { code, stderr } = typeof result === 'object' ? result : { code: result, stderr: '' };
      const dispatch = dispatchExitCode({ code, stderr, hookName }, { taskId });
      if (dispatch.action === 'noop' && dispatch.anomaly) {
        console.error(`[run-hook] anomaly: ${dispatch.anomaly.message}`);
      }
      // Dispatcher result is informational for routing layer; hook exit code is authoritative
      process.exit(code);
    })
    .catch(err => {
      console.error(`Error executing hook: ${err.message}`);
      process.exit(2);
    });
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
  detectProjectRoot,
  resolveHookScriptPath,
  buildHookEnv,
};
