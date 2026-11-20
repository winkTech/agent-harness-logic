'use strict';

const WINDOWS_DLL_FAILURES = new Set([-1073741515, 3221225781]);

function isToolchainCommand(command) {
  return /\b(vivado|xvlog|xelab|xsim|vlog|vsim|quartus(?:_sh)?|questa)\b/i.test(String(command || ''));
}

function normalizeStatus(status) {
  if (typeof status === 'number') return status;
  if (typeof status === 'string' && status.trim() !== '') {
    const parsed = Number(status);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function classifyToolchainRun(runResult = {}) {
  const command = String(runResult.command || runResult.commandLine || '');
  const status = normalizeStatus(runResult.status ?? runResult.exitCode);
  const stdout = String(runResult.stdout || '');
  const stderr = String(runResult.stderr || '');
  const error = String(runResult.error || '');
  const text = `${error}\n${stdout}\n${stderr}`;
  const toolchain = isToolchainCommand(command);

  if (status === 0 && !runResult.signal && !error) {
    return { status: 'passed', reason: 'exit code 0', toolchain };
  }

  if (toolchain && status !== null && WINDOWS_DLL_FAILURES.has(status)) {
    return {
      status: 'toolchain_failure',
      reason: `windows loader/runtime failure exit=${status}`,
      toolchain,
    };
  }

  if (/enoent|not recognized|cannot find|could not find|no such file|eacces|permission denied/i.test(text)) {
    return {
      status: toolchain ? 'toolchain_failure' : 'command_failed',
      reason: 'executable missing or inaccessible',
      toolchain,
    };
  }

  if (/dll|vcruntime|msvcp|shared libraries|library load|license checkout failed|cannot\s+load/i.test(text)) {
    return {
      status: toolchain ? 'toolchain_failure' : 'command_failed',
      reason: 'runtime/library/license failure',
      toolchain,
    };
  }

  if (toolchain && status !== 0 && stdout.trim() === '' && stderr.trim() === '' && !error) {
    return {
      status: 'toolchain_failure',
      reason: `toolchain exited without diagnostic output exit=${status}`,
      toolchain,
    };
  }

  return {
    status: 'command_failed',
    reason: status === null ? 'command did not return a normal exit code' : `exit=${status}`,
    toolchain,
  };
}

module.exports = {
  WINDOWS_DLL_FAILURES,
  classifyToolchainRun,
  isToolchainCommand,
};
