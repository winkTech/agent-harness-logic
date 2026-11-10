#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const STATUSLINE = path.join(ROOT, 'scripts', 'statusline.cjs');

function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-contract-'));
  const binDir = path.join(tempRoot, 'bin');
  const logFile = path.join(tempRoot, 'git-invocations.txt');
  fs.mkdirSync(binDir);
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(binDir, 'git.cmd'), '@echo invoked>>"%GIT_LOG%"\r\n@exit /b 0\r\n', 'utf8');
  } else {
    const gitPath = path.join(binDir, 'git');
    fs.writeFileSync(gitPath, '#!/bin/sh\necho invoked >> "$GIT_LOG"\nexit 0\n', 'utf8');
    fs.chmodSync(gitPath, 0o755);
  }
  const payload = {
    model: { display_name: 'test-model' },
    workspace: { current_dir: tempRoot },
    worktree: { branch: 'feature/statusline-fast' },
    context_window: { remaining_percentage: 90 },
  };
  const result = spawnSync(process.execPath, [STATUSLINE], {
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
      GIT_LOG: logFile,
      CLAUDE_STATUSLINE_GIT: '0',
    },
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /feature\/statusline-fast/);
  const invocations = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim() : '';
  assert.equal(invocations, '', `statusline unexpectedly invoked git: ${invocations}`);
  fs.rmSync(tempRoot, { recursive: true, force: true });
  process.stdout.write('STATUSLINE_CONTRACT_RESULT: PASS\n');
}

main();
