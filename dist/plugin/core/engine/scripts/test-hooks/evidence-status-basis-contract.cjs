#!/usr/bin/env node
'use strict';

/**
 * evidence-status-basis-contract.cjs — 观察型证据条目的状态判定契约 (D10)。
 *
 * 根因回归 (2026-07-30): commandEvidence 直接采用 classifyToolchainRun 的结论,
 * 而它对 status=null 一律判 command_failed('did not return a normal exit code')。
 * Claude Code 的 Bash tool_response 本来就不带退出码, 于是**每条**观察型条目都
 * 被记成 failed —— 实测账本里 25 条 verification.accepted=true 的通过记录中,
 * 22 条 status='failed', 账本自我矛盾, D10 的"账本无静默异常条目"因此不成立。
 *
 * 锁定: 退出码未知时按共享标记表判定 (passed/failed/unknown), 且标记表只有一份。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
// 门禁模块在加载时解析状态/账本路径, 必须先隔离再 require, 否则测试会写真实账本。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-basis-'));
process.env.HARNESS_NO_PERSIST = '1';

process.env.HARNESS_NO_PERSIST = '1';
process.env.HARNESS_VERIFY_GATE_STATE_FILE = path.join(TMP, 'verify-gate.json');
process.env.HARNESS_VERIFICATION_LEDGER_FILE = path.join(TMP, 'verification-ledger.json');
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* cleanup */ } });
const { commandEvidence, statusFromEvidence } = require(path.join(ROOT, 'core/engine/scripts/lib/evidence-ledger.cjs'));
const markers = require(path.join(ROOT, 'core/engine/scripts/lib/verification-markers.cjs'));
const verificationGate = require(path.join(ROOT, 'core/engine/scripts/hooks/verification-gate.cjs'));
const verificationState = require(path.join(ROOT, 'core/engine/scripts/lib/verification-state.cjs'));

const CMD = 'node core/engine/scripts/test-hooks/run-all-tests.cjs';

function assertNodeTestReporters() {
  const title = 'propagates watchdog failure';
  const spec = ['✔ ' + title + ' (1ms)', 'ℹ tests 1', 'ℹ pass 1', 'ℹ fail 0'].join('\r\n');
  const tap = ['TAP version 13', '# Subtest: ' + title, 'ok 1 - ' + title,
    '1..1', '# tests 1', '# pass 1', '# fail 0'].join('\n');
  for (const [reporter, stdout] of [['spec', spec], ['tap', tap]]) {
    const command = 'node --test --test-reporter=' + reporter + ' example.test.cjs';
    const verdict = (output, exitCode, stderr = '') => verificationGate.evaluate({
      hook_event_name: 'PostToolUse', tool_name: 'Bash', session_id: 'node-test', cwd: ROOT,
      tool_input: { command }, tool_response: { stdout: output, stderr, exit_code: exitCode },
    }).verification;
    assert.equal(verdict(stdout, 0)?.ok, true, reporter + ' passing title');
    assert.equal(commandEvidence(command, { stdout }).status, 'passed');
    assert.equal(verdict(stdout, 7).reason, 'exit=7');
    for (const diagnostic of ['not ok 2 - second case', 'RESULT: FAIL', 'fatal: test worker died']) {
      assert.equal(verdict(stdout, 0, diagnostic).ok, false, diagnostic);
      assert.equal(commandEvidence(command, { stdout, stderr: diagnostic }).status, 'failed');
    }
    assert.equal(verdict(stdout.replace('fail 0', 'fail 1'), 0).ok, false);
  }
  assert.equal(markers.markerVerdict('ℹ tests 0\nℹ pass 0\nℹ fail 0').status, 'unknown');
  const tapPlan = 'TAP version 13\n1..1\nok 1 - ' + title;
  assert.equal(markers.markerVerdict(tapPlan).status, 'passed');
  assert.equal(markers.markerVerdict(tapPlan + ' # SKIP').status, 'unknown');
}

function main() {
  const unscoped = (exit_code, stdout) => verificationGate.evaluate({
    hook_event_name:'PostToolUse', tool_name:'Bash', cwd:TMP, workspaceCwdUnknown:true,
    tool_input:{command:'node --test "'+path.join(ROOT,'example.test.cjs')+'"'},
    tool_response:{exit_code, stdout},
  });
  const observation = unscoped(0,'1 passed');
  assert.deepEqual(observation.diagnostics, []);
  assert.equal(observation.stateUpdated,false);
  assert.equal(observation.verification,undefined);
  assert.equal(observation.observedVerification.ok,true);
  assert.match(unscoped(9,'1 passed').diagnostics.join(' '),/exit=9/);
  assert.equal(fs.existsSync(process.env.HARNESS_VERIFICATION_LEDGER_FILE),false);
  assertNodeTestReporters();
  // 1. 退出码未知 + 正面 PASS 标记 → passed, 依据 markers
  const observedPass = commandEvidence(CMD, { stdout: 'RESULT: PASS 370/370', stderr: '' });
  assert.equal(observedPass.exitCodeKnown, false);
  assert.equal(observedPass.status, 'passed',
    'observed entry with explicit PASS evidence must not be recorded as failed');
  assert.equal(observedPass.statusBasis, 'markers');

  // 2. 退出码未知 + 失败标记 → failed
  const observedFail = commandEvidence('pytest -q', { stdout: '3 failed, 1 passed', stderr: '' });
  assert.equal(observedFail.status, 'failed');
  assert.equal(observedFail.statusBasis, 'markers');

  // 3. 退出码未知 + 无可判读证据 → unknown (既不默认通过也不默认失败)
  const observedSilent = commandEvidence('vvp tb.vvp', { stdout: '', stderr: '' });
  assert.equal(observedSilent.status, 'unknown');
  assert.equal(observedSilent.statusBasis, 'unknown');

  // 4. 明确退出码仍按退出码判定, 与标记无关
  const exitFail = commandEvidence('pytest -q', { status: 1, stdout: 'RESULT: PASS', stderr: '' });
  assert.equal(exitFail.status, 'failed', 'a known nonzero exit must outrank PASS text');
  assert.equal(exitFail.statusBasis, 'exit-code');
  const exitPass = commandEvidence('pytest -q', { status: 0, stdout: '12 passed', stderr: '' });
  assert.equal(exitPass.status, 'passed');
  assert.equal(exitPass.statusBasis, 'exit-code');

  // 5. 信号/中断即使没有退出码也按失败路径判定
  const killed = commandEvidence('vsim -c -do run.do', { status: null, signal: 'SIGTERM', stdout: '# vsim starting', stderr: '' });
  assert.equal(killed.status, 'failed');
  assert.equal(killed.statusBasis, 'exit-code');
  const interrupted = commandEvidence('pytest -q', { stdout: '12 passed', stderr: '', interrupted: true });
  assert.equal(interrupted.status, 'failed', 'interrupted runs must never be recorded as passed');

  // 6. statusFromEvidence: 观察型通过条目不再被判失败; unknown 的必需命令算未验证
  assert.equal(statusFromEvidence([observedPass], [CMD]).status, 'passed');
  assert.equal(statusFromEvidence([observedFail], ['pytest -q']).status, 'failed');
  const silentStatus = statusFromEvidence([observedSilent], ['vvp tb.vvp']);
  assert.equal(silentStatus.status, 'failed');
  assert.ok(silentStatus.failures.some((f) => /no readable verdict evidence/.test(f)), silentStatus.failures.join('|'));

  // 7. 标记表唯一: verification-gate 复用 lib 的同一个数组对象, 不是副本
  assert.equal(verificationGate.PASS_MARKERS, markers.PASS_MARKERS,
    'verification-gate must reuse the shared marker table, not a copy (two-list drift defect)');

  // 8. 门禁判定与账本判定对同一输出必须同向
  for (const [stdout, expectOk] of [
    ['RESULT: PASS 370/370', true],
    ['3 failed, 1 passed', false],
    ['', false],
    ['simulation finished at 1200 ns', false],
  ]) {
    const gate = verificationGate.evaluate({
      hook_event_name: 'PostToolUse', tool_name: 'Bash', session_id: 'basis', cwd: ROOT,
      tool_input: { command: 'pytest -q' }, tool_response: { stdout, stderr: '', interrupted: false },
    });
    assert.equal(gate.verification.ok, expectOk, `gate verdict drifted for stdout=${JSON.stringify(stdout)}`);
    const entry = commandEvidence('pytest -q', { stdout, stderr: '' });
    if (expectOk) assert.equal(entry.status, 'passed', 'ledger must agree with an accepted gate verdict');
    else assert.notEqual(entry.status, 'passed', 'ledger must not record a rejected verdict as passed');
  }

  // A passing run can only settle edits that were already pending when it started.
  const clock = Date.now();
  const sessionId = 'concurrent-edit';
  const pending = () => verificationState.pendingForCwd(
    verificationState.readVerificationState(), ROOT, { sessionId },
  );
  const edit = () => verificationState.markEdited({
    cwd: ROOT, sessionId, filePath: path.join(ROOT, 'src', 'sample.py'),
    now: new Date(clock - 1000).toISOString(),
  });
  const finish = (timing) => verificationGate.evaluate({
    hook_event_name: 'PostToolUse', tool_name: 'Bash', session_id: sessionId, cwd: ROOT,
    tool_input: { command: 'pytest -q' },
    tool_response: { stdout: '2 passed', exit_code: 0, ...timing },
  });
  edit();
  const previousResult = finish({ startedAt: new Date(clock - 2000).toISOString() });
  assert.equal(previousResult.verification.ok, true);
  assert.equal(previousResult.stateUpdated, false);
  assert.equal(pending().length, 1, 'a passing test started before the edit must leave it pending');
  finish({ completedAt: new Date(clock).toISOString(), durationMs: 2000 });
  assert.equal(pending().length, 1, 'completion and duration also establish when a test started');
  finish({ startedAt: new Date(clock - 500).toISOString() });
  assert.equal(pending().length, 0, 'a subsequent passing test must clear the edit');
  edit();
  finish({});
  assert.equal(pending().length, 0, 'legacy payloads without timing retain existing behavior');

  console.log('evidence-status-basis-contract: all assertions passed');
}

main();
