'use strict';

/**
 * Legacy re-export shim.
 *
 * The underlying module ../tools/cli/run-hook.cjs no longer exists.
 * All exported functions are no-op stubs for backward compatibility.
 *
 * Hook dispatching now goes through the runners in engine/scripts/hooks/:
 *   local-runner.cjs   — local scripts (engine/scripts/hooks/*)
 *   stop-runner.cjs    — stop/session-end hooks with ECC plugin support
 *   ecc-runner.cjs     — ECC plugin hooks
 *
 * TODO: Remove this file once all import sites have been migrated.
 */

function noop() {}
function stub() { return noop; }

module.exports = {
  main: noop,
  detectProjectRoot: noop,
  resolveHookScriptPath: noop,
  buildHookEnv: noop,
};
