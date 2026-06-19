'use strict';

/**
 * @deprecated since 2026-06-19
 *
 * This module was originally a re-export shim pointing to
 * .claude/tools/cli/run-hook.cjs, which no longer exists.
 *
 * The require has been replaced with a graceful try-catch so that
 * any file still importing this module does not crash.  All exported
 * functions are replaced with no-op stubs that log a deprecation
 * warning at first call.
 *
 * TODO: Remove this file once all import sites have been migrated.
 */

const warned = new Set();

function deprecationWarning(name) {
  if (!warned.has(name)) {
    warned.add(name);
    console.warn(
      `[deprecated] engine/hooks/run-hook.cjs#${name}() — ` +
        `the underlying module ../tools/cli/run-hook.cjs no longer exists. ` +
        `This is a no-op stub. Please remove or update the caller.`
    );
  }
}

let impl;
try {
  impl = require('../tools/cli/run-hook.cjs');
} catch {
  impl = null;
}

function stub(name) {
  return function () {
    deprecationWarning(name);
  };
}

const main = impl?.main ?? stub('main');
const detectProjectRoot = impl?.detectProjectRoot ?? stub('detectProjectRoot');
const resolveHookScriptPath = impl?.resolveHookScriptPath ?? stub('resolveHookScriptPath');
const buildHookEnv = impl?.buildHookEnv ?? stub('buildHookEnv');

module.exports = { main, detectProjectRoot, resolveHookScriptPath, buildHookEnv };

if (require.main === module) {
  main();
}
