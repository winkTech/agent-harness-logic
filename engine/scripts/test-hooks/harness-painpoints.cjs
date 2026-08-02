#!/usr/bin/env node
/**
 * Regression tests for harness failure modes found during the audit.
 *
 * These are intentionally behavior-focused:
 * - rules must be loaded deterministically, not by agent self-memory
 * - stale gate state must not unlock unrelated future work
 * - cleanup commands must not count as functional verification
 * - workflow evidence checks must not be delegated to agent self-report
 * - context compression must preserve hard constraints
 * - persistent prompts must keep authorization, evidence, scope, and test integrity explicit
 */

'use strict';

const { HARNESS_ROOT } = require('../lib/harness-root.cjs');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  collectHookEntries,
  validateHookScripts,
} = require('../lib/hook-registry.cjs');

const HOME = HARNESS_ROOT;

/**
 * 固定的假项目根，用于构造 hook payload 的 cwd / file_path。
 *
 * 必须是**当前平台意义上的绝对路径**。原先硬编码 'C:/repo'，在 Linux 上那是相对路径：
 * hook 内部会把它解析成 `<process.cwd()>/C:/repo`，于是 payload 里的 projectId 与测试
 * 侧 `memoryProjectId('C:/repo')` 算出来的对不上，记忆检索命中不了，注入为空 ——
 * 表现为 "did not inject context" 与 "did not hard-scope the failure signature"。
 * Windows 上跑不出来，只有 CI 的 ubuntu 腿会红。
 */
const FIXTURE_REPO = process.platform === 'win32' ? 'C:/repo' : '/repo';

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * 显式跳过：用于"检的是本机操作员配置、不是仓库契约"的断言。
 * 这类断言依赖 settings.json / var/ 这些 .gitignore 的路径，全新 checkout 与 CI 上
 * 根本不存在，硬跑必然误报。跳过必须**打印出来**，不能当成 PASS 混过去 ——
 * 否则就分不清"检过了"和"没检"。
 */
class SkippedTest extends Error {}

function skip(reason) {
  throw new SkippedTest(reason);
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function runNode(scriptPath, stdin, env = {}) {
  return spawnSync('node', [scriptPath], {
    input: stdin || '',
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
    env: { ...process.env, ...env },
  });
}

function withFileBackup(filePath, fn) {
  const existed = fs.existsSync(filePath);
  const original = existed ? fs.readFileSync(filePath) : null;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    return fn();
  } finally {
    if (existed) {
      fs.writeFileSync(filePath, original);
    } else {
      try { fs.unlinkSync(filePath); } catch {}
    }
  }
}

test('rule loader scopes gates to new assets while preserving HDL/Python file rules', () => {
  const loader = require(path.join(HOME, 'engine/scripts/rule-loader.cjs'));
  loader.invalidateRuleIndex();

  const filesFor = (result) => new Set([...(result.matches || []), ...(result.allMatches || [])].map(item => (
    typeof item === 'string' ? item.replace(/\[.*$/, '') : item.file
  )));

  const hdl = loader.evaluate('review existing RTL module', { openFiles: ['src/top.sv'] });
  assert(hdl, 'HDL evaluation returned no rules');
  assert(hdl.mode === 'capsule', `rule loader default mode should be capsule, got ${hdl.mode}`);
  assert(!hdl.ruleContents, 'rule loader injected full ruleContents by default');
  assert(typeof hdl.capsule === 'string' && hdl.capsule.length <= 1800, 'rule capsule missing or too large');
  const hdlFiles = filesFor(hdl);
  assert(hdlFiles.has('00-core.md'), '00-core.md was not loaded for HDL work');
  assert(hdlFiles.has('01-hdl.md'), '01-hdl.md was not loaded for .sv work');
  assert(!hdlFiles.has('03-gates.md'), '03-gates.md should not load for read-only HDL review');

  const newHdl = loader.evaluate('create a new module and verification plan', { openFiles: ['src/new_top.sv'] });
  assert(newHdl, 'new HDL evaluation returned no rules');
  const newHdlFiles = filesFor(newHdl);
  assert(newHdlFiles.has('00-core.md'), '00-core.md was not loaded for new HDL work');
  assert(newHdlFiles.has('01-hdl.md'), '01-hdl.md was not loaded for new .sv work');
  assert(newHdlFiles.has('03-gates.md'), '03-gates.md was not loaded for new HDL work');

  const py = loader.evaluate('modify existing code', { openFiles: ['tools/analyze.py'] });
  assert(py, 'Python evaluation returned no rules');
  const pyFiles = filesFor(py);
  assert(pyFiles.has('00-core.md'), '00-core.md was not loaded for Python work');
  assert(pyFiles.has('02-python.md'), '02-python.md was not loaded for .py work');
  assert(!pyFiles.has('03-gates.md'), '03-gates.md should not load for an existing Python edit');

  const newPy = loader.evaluate('create a new code file and verification plan', { openFiles: ['tools/new_parser.py'] });
  assert(newPy, 'new Python evaluation returned no rules');
  const newPyFiles = filesFor(newPy);
  assert(newPyFiles.has('00-core.md'), '00-core.md was not loaded for new Python work');
  assert(newPyFiles.has('02-python.md'), '02-python.md was not loaded for new .py work');
  assert(newPyFiles.has('03-gates.md'), '03-gates.md was not loaded for new Python work');
});

test('persistent prompts share a scoped evidence-driven contract with a Claude delta', () => {
  const agents = fs.readFileSync(path.join(HOME, 'AGENTS.md'), 'utf8').replace(/\r\n/g, '\n');
  const claude = fs.readFileSync(path.join(HOME, 'CLAUDE.md'), 'utf8').replace(/\r\n/g, '\n');
  const core = fs.readFileSync(path.join(HOME, 'docs/rules/00-core.md'), 'utf8');
  const gates = fs.readFileSync(path.join(HOME, 'docs/rules/03-gates.md'), 'utf8');

  const normalizedAgents = agents.replace(/^# Codex 项目指导/m, '# 共享项目指导').trim();
  const claudeCommon = claude.split('\n## Claude 模型校准\n')[0]
    .replace(/^# Claude Code 项目指导/m, '# 共享项目指导')
    .trim();
  const stopSection = (agents.split('\n## 停止规则\n')[1] || '').split('\n## ')[0];
  const stopBullets = stopSection.match(/^- /gm) || [];

  assert(normalizedAgents === claudeCommon, 'Codex and Claude common guidance drifted');
  assert(!agents.includes('## 目标与完成标准'), 'duplicated completion guidance was not removed');
  assert(!agents.includes('## 协作与工具沟通'), 'duplicated collaboration guidance was not removed');
  assert(agents.includes('透明度账本'), 'repository-specific transparency ledger guidance was lost');
  assert(stopBullets.length === 1, `stop rules must contain exactly one bullet, found ${stopBullets.length}`);
  assert(stopSection.includes('同一方法连续失败两次后改变方法'), 'two-failure method-change stop rule missing');
  assert(agents.includes('明确请求“提交、推送、发布、发送”即授权'), 'explicit external action authorization missing');
  assert(agents.includes('无需重复确认'), 'prompt may ask twice for already explicit authorization');
  assert(agents.includes('先读取或验证再作结论'), 'evidence-before-claims guidance missing');
  assert(agents.includes('不顺带重构、增加抽象、扩展功能'), 'anti-overengineering guidance missing');
  assert(agents.includes('普通任务不创建进度文件'), 'long-task state is not scoped away from simple work');
  assert(claude.includes('## Claude 模型校准'), 'Claude-specific calibration layer missing');
  assert(claude.includes('默认直接完成简单、单文件或强顺序任务'), 'Claude subagent overuse guard missing');
  assert(core.includes('不重复授权、沟通、验证和停止规则'), '00-core still duplicates the persistent contract');
  assert(gates.includes('不得仅为制造通过而削弱、删除或跳过测试'), 'test-integrity rule missing');
});

test('postflight telemetry uses one precise observer process per lifecycle event', () => {
  const settingsFile = path.join(HOME, 'settings.json');
  const entries = collectHookEntries({ files: [settingsFile] });
  const postflight = entries.filter(entry => entry.command.includes('postflight-observer.cjs'));
  for (const point of ['PostToolUse', 'PostToolUseFailure', 'Stop']) {
    const routes = postflight.filter(entry => entry.point === point);
    assert(routes.length === 1, `expected one ${point} postflight observer, found ${routes.length}`);
    assert(routes[0].isAsync, `${point} postflight observer must be async/fail-open`);
  }

  const retired = /signal-collector\.cjs|skill-tracker-hook\.cjs|cost-tracker-hook\.cjs|memory-sqlite-sync\.cjs|memory-track\.sh post-message|auto-record-success\.sh|agent-transparency-ledger\.cjs|skill-evolve\.cjs/;
  const activeRetired = entries.filter(entry =>
    ['PostToolUse', 'PostToolUseFailure'].includes(entry.point) && retired.test(entry.command)
  );
  assert(activeRetired.length === 0, `legacy observer remains active: ${activeRetired[0]?.command}`);
  const stateRoutes = entries.filter(entry => ['PostToolUse', 'PostToolUseFailure'].includes(entry.point)
      && entry.command.includes('postflight-router.cjs'));
  assert(stateRoutes.length === 2 && stateRoutes.every(entry => !entry.isAsync),
    'PostToolUse and PostToolUseFailure must each use one synchronous state router');
  const legacyStateRoutes = entries.filter(entry => ['PostToolUse', 'PostToolUseFailure'].includes(entry.point)
      && /cross-link-memory\.cjs|verification-gate\.cjs|progress-watchdog\.cjs|toolchain-health-gate\.cjs|local-runner\.cjs/.test(entry.command));
  assert(legacyStateRoutes.length === 0,
    `legacy postflight state process remains active: ${legacyStateRoutes[0]?.command}`);

  const missing = validateHookScripts({ files: [settingsFile] }).missing
    .filter(record => record.command.includes('postflight-observer.cjs'));
  assert(missing.length === 0, `postflight observer is missing: ${missing.map(item => item.source).join(', ')}`);
});

test('ordinary hook paths do not auto-run simulation governance or scan FPGA reports', () => {
  const entries = collectHookEntries({ files: [path.join(HOME, 'settings.json')] });
  const hot = entries.filter(entry => /sim-governance\.cjs|auto-parse-fpga-reports\.cjs/.test(entry.command));
  assert(hot.length === 0, `explicit validation helper remains in automatic ${hot[0]?.point}: ${hot[0]?.command}`);
  assert(fs.existsSync(path.join(HOME, 'engine/hooks/safety/sim-governance.cjs')),
    'sim-governance explicit helper was deleted instead of retired from hooks');
  assert(fs.existsSync(path.join(HOME, 'engine/scripts/auto-parse-fpga-reports.cjs')),
    'FPGA report parser was deleted instead of retained for explicit validation');
});

test('Stop reports state without linting the entire dirty worktree', () => {
  const entries = collectHookEntries({ files: [path.join(HOME, 'settings.json')] });
  const stopLint = entries.find(entry => entry.point === 'Stop' && entry.command.includes('lint-auto-gate.js'));
  assert(!stopLint, `Stop still runs full-tree lint: ${stopLint?.command}`);
  assert(fs.existsSync(path.join(HOME, 'engine/scripts/hooks/lint-auto-gate.js')),
    'lint helper was deleted instead of retained for explicit validation');
});

test('postflight observer records failures but never labels successful tools as drift_stuck', () => {
  const observer = require(path.join(HOME, 'engine/hooks/learning/postflight-observer.cjs'));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'postflight-signal-'));
  const dbPath = path.join(tempDir, 'signals.db');
  const success = observer.handlePayload({
    hook_event_name: 'PostToolUse',
    session_id: 'signal-session',
    tool_name: 'Bash',
    tool_input: { command: 'git status' },
    tool_response: { status: 0, stdout: 'clean', stderr: '' },
  }, { dbPath });
  const failure = observer.handlePayload({
    hook_event_name: 'PostToolUseFailure',
    session_id: 'signal-session',
    tool_name: 'Bash',
    tool_input: { command: 'pytest' },
    tool_response: { status: 1, stdout: '', stderr: '1 failed' },
  }, { dbPath });
  const { openDb } = require(path.join(HOME, 'engine/sqlite/index.cjs'));
  const wDb = openDb({ path: dbPath });
  const rows = wDb.db.prepare('SELECT type, COUNT(*) AS count FROM runtime_events GROUP BY type').all();
  wDb.close();
  fs.rmSync(tempDir, { recursive: true, force: true });

  assert(success.actions.join(',') === 'memory:attribution',
    `successful ordinary tool produced unexpected telemetry: ${success.actions}`);
  assert(failure.actions.join(',') === 'signal:tool_fail,memory:attribution',
    `failure route mismatch: ${failure.actions}`);
  assert(rows.length === 1 && rows[0].type === 'tool_fail' && rows[0].count === 1,
    `unexpected signal rows: ${JSON.stringify(rows)}`);
});

test('postflight observer shares one database connection across exact Skill and Stop routes', () => {
  const observer = require(path.join(HOME, 'engine/hooks/learning/postflight-observer.cjs'));
  const sqlite = require(path.join(HOME, 'engine/sqlite/index.cjs'));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'postflight-routes-'));
  const dbPath = path.join(tempDir, 'routes.db');
  let opens = 0;
  const trackedOpen = (opts) => {
    opens += 1;
    return sqlite.openDb(opts);
  };
  const skill = observer.handlePayload({
    hook_event_name: 'PostToolUse',
    session_id: 'route-session',
    tool_name: 'Skill',
    tool_input: { skill: 'hdl-coding', args: 'review RTL' },
    tool_response: { status: 0 },
  }, { dbPath, openDb: trackedOpen });
  const stop = observer.handlePayload({
    hook_event_name: 'Stop',
    session_id: 'route-session',
    last_assistant_message: 'Completed the requested review.',
  }, { dbPath, openDb: trackedOpen });
  const wDb = sqlite.openDb({ path: dbPath });
  const skillEvents = wDb.db.prepare("SELECT COUNT(*) AS count FROM runtime_events WHERE type='skill_trigger'").get().count;
  const costs = wDb.db.prepare('SELECT COUNT(*) AS count FROM cost_ledger').get().count;
  wDb.close();
  fs.rmSync(tempDir, { recursive: true, force: true });

  assert(opens === 2, `expected one DB open per routed event, got ${opens}`);
  assert(skill.actions.join(',') === 'skill:hdl-coding,memory:attribution' && skillEvents === 1,
    `Skill payload was not routed exactly: ${skill.actions}, events=${skillEvents}`);
  assert(stop.actions.join(',') === 'cost:estimate' && costs === 1,
    `Stop payload was not routed to cost only: ${stop.actions}, costs=${costs}`);
});

test('postflight observer syncs only real tool_input memory paths and warns on dropped writes', () => {
  const observer = require(path.join(HOME, 'engine/hooks/learning/postflight-observer.cjs'));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'postflight-memory-'));
  const memoryDir = path.join(tempDir, 'memory');
  const memoryFile = path.join(memoryDir, 'learnings', 'routing.md');
  const dbPath = path.join(tempDir, 'memory.db');
  fs.mkdirSync(path.dirname(memoryFile), { recursive: true });
  fs.writeFileSync(memoryFile, '# Routing\nUse exact tool_input.file_path payloads.\n', 'utf8');
  const synced = observer.handlePayload({
    hook_event_name: 'PostToolUse',
    session_id: 'memory-session',
    tool_name: 'Write',
    tool_input: { file_path: memoryFile },
    tool_response: { status: 0 },
  }, { dbPath, memoryDir });
  const warnings = [];
  const dropped = observer.handlePayload({
    hook_event_name: 'PostToolUseFailure',
    session_id: 'dropped-write-session',
    tool_name: 'Bash',
    tool_input: { command: 'false' },
  }, {
    openDb() { throw new Error('database is locked'); },
    warn(record) { warnings.push(record); },
  });
  const { openDb } = require(path.join(HOME, 'engine/sqlite/index.cjs'));
  const wDb = openDb({ path: dbPath });
  const facts = wDb.db.prepare("SELECT COUNT(*) AS count FROM facts WHERE source='hook:postflight-observer'").get().count;
  wDb.close();
  fs.rmSync(tempDir, { recursive: true, force: true });

  assert(synced.actions.join(',') === 'memory:sync,memory:attribution' && facts === 1,
    `memory payload was not synced: ${synced.actions}, facts=${facts}`);
  assert(dropped.dropped === true && warnings.length === 1,
    'SQLite write failure was not surfaced as one fail-open warning');
  assert(warnings[0].event === 'postflight-observer-warning'
      && warnings[0].kind === 'dropped-write'
      && warnings[0].errorCode === 'SQLITE_WRITE_DROPPED',
    `warning is not structured: ${JSON.stringify(warnings[0])}`);
});

test('memory facts use stable sources and reconciliation tombstones missing or moved files', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-fact-sources-'));
  const dbPath = path.join(tempDir, 'facts.db');
  const { openDb } = require(path.join(HOME, 'engine/sqlite/index.cjs'));
  const store = require(path.join(HOME, 'engine/sqlite/store-memory.cjs'));
  const wDb = openDb({ path: dbPath });
  const first = store.writeMemory({
    namespace: 'learnings',
    name: 'stable-source',
    content: 'first verified resolution',
    source: 'hook:postflight-observer',
    sourcePath: path.join(tempDir, 'memory', 'learnings', 'stable-source.md'),
    sourceKey: 'memory/learnings/stable-source.md',
  }, { db: wDb.db });
  const updated = store.writeMemory({
    namespace: 'learnings',
    name: 'stable-source',
    content: 'updated verified resolution',
    source: 'hook:postflight-observer',
    sourcePath: path.join(tempDir, 'memory', 'learnings', 'stable-source.md'),
    sourceKey: 'memory/learnings/stable-source.md',
  }, { db: wDb.db });

  const beforeMove = wDb.db.prepare(
    'SELECT id, source_path, source_key, status, content FROM facts WHERE source_key = ?',
  ).get('memory/learnings/stable-source.md');
  assert(first.id === updated.id && beforeMove.content === 'updated verified resolution',
    'same source created a second content-addressed fact instead of replacing the row');
  assert(beforeMove.status === 'active' && beforeMove.source_path.endsWith('stable-source.md'),
    `source metadata was not persisted: ${JSON.stringify(beforeMove)}`);

  const moved = store.reconcileMemoryFacts([{
    namespace: 'learnings',
    name: 'stable-source',
    content: 'updated verified resolution',
    source: 'reconcile:file',
    sourcePath: path.join(tempDir, 'memory', 'learnings', 'renamed.md'),
    sourceKey: 'memory/learnings/renamed.md',
  }], { db: wDb.db });
  const afterMove = wDb.db.prepare('SELECT id, source_key, status FROM facts').all();
  assert(moved.moved === 1 && afterMove.length === 1 && afterMove[0].id === first.id
      && afterMove[0].source_key === 'memory/learnings/renamed.md',
    `move reconciliation lost stable identity: ${JSON.stringify({ moved, afterMove })}`);

  const dream = store.writeMemory({
    namespace: 'learnings',
    name: 'dream-candidate',
    content: 'review-only runtime candidate',
    source: 'script:dream',
    sourceKey: 'dream:stable-candidate',
    confidence: 0.4,
  }, { db: wDb.db });
  const removed = store.reconcileMemoryFacts([], { db: wDb.db });
  const tombstone = wDb.db.prepare('SELECT status FROM facts WHERE id = ?').get(first.id);
  const dreamStatus = wDb.db.prepare('SELECT status FROM facts WHERE id = ?').get(dream.id);
  const hidden = store.retrieveMemory('updated verified resolution', {
    db: wDb.db,
    namespaces: ['learnings'],
    trackHit: false,
  });
  const stats = store.memoryStats({ db: wDb.db });
  wDb.close();
  fs.rmSync(tempDir, { recursive: true, force: true });

  assert(removed.tombstoned === 1 && tombstone.status === 'tombstone',
    `missing source was not tombstoned: ${JSON.stringify({ removed, tombstone })}`);
  assert(dreamStatus.status === 'active',
    `file reconciliation revoked a non-file fact: ${JSON.stringify(dreamStatus)}`);
  assert(hidden.length === 0, 'tombstoned fact remained retrievable');
  assert(stats.total === 1, `memory stats counted inactive facts: ${JSON.stringify(stats)}`);
});

test('memory sync rejects noise and only gives verified errors high confidence', () => {
  const observer = require(path.join(HOME, 'engine/hooks/learning/postflight-observer.cjs'));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-sync-policy-'));
  const memoryDir = path.join(tempDir, 'memory');
  const write = (relative, content) => {
    const file = path.join(memoryDir, ...relative.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
    return file;
  };

  const noise = [
    write('errors/hook_failure_20260728.md', '# Hook failure\nraw stack only\n'),
    write('work/tool_success_20260728.md', '# Success\ncommand completed\n'),
    write('learnings/template.md', '# Template\nReplace this text.\n'),
    write('learnings/placeholder.md', '# Placeholder\nTODO\n'),
    write('learnings/obsolete.md', '---\nstatus: obsolete\n---\n# Old rule\nDo the old thing.\n'),
  ];
  for (const file of noise) {
    assert(observer.parseMemoryFact(file, memoryDir) === null,
      `noise memory was accepted for sync: ${path.basename(file)}`);
  }

  const unverifiedFile = write('errors/unverified.md', '# Timing error\nObserved once; root cause unknown.\n');
  const verifiedFile = write('errors/verified.md', [
    '---',
    'verified: true',
    'project_id: project-a',
    'scope_kind: path',
    'path_scope: rtl/**',
    'trigger_kind: file_edit',
    'trigger_signature: rx_fifo',
    'evidence_ref: test:focused-regression',
    'contract_hash: sha256:test-contract',
    'valid_until: 2026-12-31T00:00:00.000Z',
    '---',
    '# Timing error resolution',
    'Root cause and focused regression both confirmed.',
    '',
  ].join('\n'));
  const learningFile = write('learnings/stable.md', '# Stable learning\nUse exact event payload semantics.\n');
  const unverified = observer.parseMemoryFact(unverifiedFile, memoryDir);
  const verified = observer.parseMemoryFact(verifiedFile, memoryDir);
  const learning = observer.parseMemoryFact(learningFile, memoryDir);
  fs.rmSync(tempDir, { recursive: true, force: true });

  assert(unverified && unverified.confidence <= 0.5,
    `unverified error received promoted confidence: ${unverified?.confidence}`);
  assert(verified && verified.confidence === 0.9,
    `verified error was not promoted: ${verified?.confidence}`);
  assert(verified?.projectId === 'project-a' && verified.scopeKind === 'path'
      && verified.pathScope === 'rtl/**' && verified.triggerKind === 'file_edit'
      && verified.triggerSignature === 'rx_fifo' && verified.verificationState === 'verified'
      && verified.evidenceRef === 'test:focused-regression'
      && verified.contractHash === 'sha256:test-contract'
      && Number.isFinite(verified.validUntil),
    `memory applicability frontmatter was not preserved: ${JSON.stringify(verified)}`);
  assert(learning && learning.source_key === 'learnings/stable.md'
      && learning.source_path.endsWith('stable.md'),
    `stable source identity missing from parsed fact: ${JSON.stringify(learning)}`);
});

test('memory retrieval is readonly scoped relevant and returns provenance metadata', () => {
  const hook = require(path.join(HOME, 'engine/scripts/memory-retrieve-hook.cjs'));
  const injectedDb = { marker: 'readonly-db' };
  let openOptions = null;
  let receivedDb = null;
  const receivedCalls = [];
  let closed = false;
  const results = hook.doMemoryQuery('how to fix FPGA timing negative hold slack error', 'user', {
    openDb(options) {
      openOptions = options;
      return { db: injectedDb, close() { closed = true; } };
    },
    retrieveMemorySummary(_query, options) {
      receivedDb = options.db;
      receivedCalls.push(options);
      return [
        {
          namespace: 'errors', name: 'negative-hold',
          summary: 'FPGA timing failed because negative hold slack remained after route.',
          confidence: 0.9, source: 'reconcile:file', source_key: 'errors/negative-hold.md',
          status: 'active', updated_at: 1722124800000,
        },
        {
          namespace: 'errors', name: 'generic-error-template',
          summary: 'Generic error template for unrelated software.',
          confidence: 0.8, source: 'migration:file', source_key: 'errors/generic.md',
          status: 'active', updated_at: 1722124800000,
        },
      ];
    },
  });

  assert(openOptions?.readonly === true && receivedDb === injectedDb && closed,
    `retrieval did not use and close the readonly handle: ${JSON.stringify({ openOptions, receivedDb, closed })}`);
  // 两层召回契约 (2026-07-29): 每次调用都禁写 hit; verified 层保持 ≥0.7 且不含候选;
  // 候选补位层必须显式 includeCandidates 且置信下限 ≥0.6 (挡住 0.3/0.4 噪声)。
  assert(receivedCalls.length >= 1 && receivedCalls.every((o) => o.trackHit === false),
    `automatic retrieval violated hit-tracking policy: ${JSON.stringify(receivedCalls)}`);
  const verifiedCall = receivedCalls[0];
  assert(verifiedCall.minConfidence >= 0.7 && !verifiedCall.includeCandidates,
    `verified tier violated trust policy: ${JSON.stringify(verifiedCall)}`);
  for (const call of receivedCalls.slice(1)) {
    assert(call.includeCandidates === true && call.minConfidence >= 0.6,
      `candidate tier violated bounded-candidate policy: ${JSON.stringify(call)}`);
  }
  assert(results.length === 1 && results[0].name === 'negative-hold',
    `minimum relevance retained generic matches: ${JSON.stringify(results)}`);
  assert(results[0].source === 'reconcile:file' && results[0].sourceKey === 'errors/negative-hold.md'
      && results[0].status === 'active' && results[0].updatedAt === 1722124800000,
    `retrieval provenance metadata missing: ${JSON.stringify(results[0])}`);

  const base = hook.cacheKey('user-query', 'same query', {
    project: `${FIXTURE_REPO}/a`, cwd: `${FIXTURE_REPO}/a`, session: 'session-a',
  });
  const otherSession = hook.cacheKey('user-query', 'same query', {
    project: `${FIXTURE_REPO}/a`, cwd: `${FIXTURE_REPO}/a`, session: 'session-b',
  });
  const otherProject = hook.cacheKey('user-query', 'same query', {
    project: `${FIXTURE_REPO}/b`, cwd: `${FIXTURE_REPO}/b`, session: 'session-a',
  });
  assert(base !== otherSession && base !== otherProject,
    'memory cache key is not scoped by project/cwd/session');
});

test('memory relevance recognizes Chinese task signatures and rejects unrelated Chinese matches', () => {
  const hook = require(path.join(HOME, 'engine/scripts/memory-retrieve-hook.cjs'));
  const query = '怎么解决接收缓冲区空读污染帧状态';
  const terms = hook.distinctiveQueryTerms(query);
  const relevant = {
    name: '接收缓冲区空读保护',
    summary: '接收缓冲区为空时禁止读操作，避免污染帧状态。',
    source_key: 'learnings/rx-empty-read.md',
  };
  const unrelated = {
    name: '软件界面缓存设置',
    summary: '调整界面颜色缓存并刷新显示状态。',
    source_key: 'learnings/ui-cache.md',
  };

  assert(terms.some((term) => /[一-鿿]/.test(term)),
    `Chinese task signature was discarded: ${JSON.stringify(terms)}`);
  assert(hook.relevantResult(query, relevant) === true,
    `relevant Chinese memory was rejected: ${JSON.stringify(terms)}`);
  assert(hook.relevantResult(query, unrelated) === false,
    `unrelated Chinese memory was accepted: ${JSON.stringify(terms)}`);
});

test('memory context queries retain discriminating directory components', () => {
  const hook = require(path.join(HOME, 'engine/scripts/memory-retrieve-hook.cjs'));
  assert(typeof hook.buildContextQuery === 'function', 'buildContextQuery is not an exported contract');
  const query = hook.buildContextQuery(`${FIXTURE_REPO}/decoder/control/common.sv`).toLowerCase();
  assert(query.includes('decoder') && query.includes('control') && query.includes('common'),
    `directory context was discarded from memory query: ${query}`);
  assert(!query.includes('c:') && !query.includes('repo'),
    `absolute or generic path components leaked into memory query: ${query}`);
});

test('memory project ids canonicalize equivalent roots and isolate different roots', () => {
  const projectScope = require(path.join(HOME, 'engine/scripts/lib/project-scope.cjs'));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-project-id-'));
  const repoA = path.join(tempDir, 'Repo-A');
  const repoB = path.join(tempDir, 'Repo-B');
  fs.mkdirSync(repoA, { recursive: true });
  fs.mkdirSync(repoB, { recursive: true });

  let canonical;
  let equivalent;
  let isolated;
  try {
    assert(typeof projectScope.memoryProjectId === 'function',
      'project-scope does not export memoryProjectId');
    canonical = projectScope.memoryProjectId(repoA);
    const equivalentRoot = process.platform === 'win32'
      ? `${repoA.toUpperCase().replace(/\\/g, '/')}/`
      : `${repoA.replace(/\\/g, '/')}/`;
    equivalent = projectScope.memoryProjectId(equivalentRoot);
    isolated = projectScope.memoryProjectId(repoB);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  assert(canonical && canonical === equivalent,
    `equivalent project roots produced different memory ids: ${canonical} vs ${equivalent}`);
  assert(canonical !== isolated,
    `different project roots shared one memory id: ${canonical}`);
});

test('memory retrieval hard-isolates repository facts before relevance ranking', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-project-scope-'));
  const dbPath = path.join(tempDir, 'memory.db');
  const { openDb } = require(path.join(HOME, 'engine/sqlite/index.cjs'));
  const store = require(path.join(HOME, 'engine/sqlite/store-memory.cjs'));
  const wDb = openDb({ path: dbPath });

  store.writeMemory({
    namespace: 'learnings',
    name: 'repo-a-rx-fifo',
    content: 'rx fifo verified resolution for repository A only',
    confidence: 0.9,
    sourceKey: 'repo-a:rx-fifo',
    projectId: 'project-a',
    scopeKind: 'repository',
    pathScope: 'rtl/**',
    triggerKind: 'file_edit',
    triggerSignature: 'rx_fifo',
    verificationState: 'verified',
    evidenceRef: 'test:repo-a-rx-fifo',
    validUntil: Date.now() + 86_400_000,
  }, { db: wDb.db });
  store.writeMemory({
    namespace: 'learnings',
    name: 'repo-b-rx-fifo',
    content: 'rx fifo verified resolution for repository B only',
    confidence: 0.9,
    sourceKey: 'repo-b:rx-fifo',
    projectId: 'project-b',
    scopeKind: 'repository',
    pathScope: 'rtl/**',
    triggerKind: 'file_edit',
    triggerSignature: 'rx_fifo',
    verificationState: 'verified',
    evidenceRef: 'test:repo-b-rx-fifo',
    validUntil: Date.now() + 86_400_000,
  }, { db: wDb.db });

  const results = store.retrieveMemory('rx fifo verified resolution', {
    db: wDb.db,
    minConfidence: 0.7,
    trackHit: false,
    scope: {
      projectId: 'project-a',
      relativePath: 'rtl/rx_fifo.sv',
      triggerKind: 'file_edit',
      triggerSignature: 'rx_fifo',
    },
  });
  wDb.close();
  fs.rmSync(tempDir, { recursive: true, force: true });

  assert(results.length === 1 && results[0].name === 'repo-a-rx-fifo',
    `cross-project fact leaked into retrieval: ${JSON.stringify(results)}`);
});

test('memory retrieval without trigger scope fails closed while explicit review remains available', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-missing-scope-'));
  const dbPath = path.join(tempDir, 'memory.db');
  const { openDb } = require(path.join(HOME, 'engine/sqlite/index.cjs'));
  const store = require(path.join(HOME, 'engine/sqlite/store-memory.cjs'));
  const wDb = openDb({ path: dbPath });
  const shared = {
    namespace: 'learnings', confidence: 0.9, verificationState: 'verified',
    evidenceRef: 'test:missing-scope', validUntil: Date.now() + 86_400_000,
    triggerKind: 'user_query',
  };
  store.writeMemory({
    ...shared,
    name: 'global-contract',
    content: 'memory missing scope isolation contract global',
    sourceKey: 'global:missing-scope',
    scopeKind: 'global_harness',
  }, { db: wDb.db });
  store.writeMemory({
    ...shared,
    name: 'project-contract',
    content: 'memory missing scope isolation contract project',
    sourceKey: 'project-a:missing-scope',
    projectId: 'project-a',
    scopeKind: 'repository',
  }, { db: wDb.db });

  const safe = store.retrieveMemory('memory missing scope isolation contract', {
    db: wDb.db, trackHit: false,
  });
  const review = store.retrieveMemory('memory missing scope isolation contract', {
    db: wDb.db, trackHit: false, allowCrossScopeReview: true,
  });
  wDb.close();
  fs.rmSync(tempDir, { recursive: true, force: true });

  assert(safe.length === 0,
    `missing trigger scope exposed automatic memory: ${JSON.stringify(safe)}`);
  assert(review.length === 2,
    `explicit cross-scope review could not inspect all facts: ${JSON.stringify(review)}`);
});

test('memory retrieval enforces path scopes inside the selected repository', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-path-scope-'));
  const dbPath = path.join(tempDir, 'memory.db');
  const { openDb } = require(path.join(HOME, 'engine/sqlite/index.cjs'));
  const store = require(path.join(HOME, 'engine/sqlite/store-memory.cjs'));
  const wDb = openDb({ path: dbPath });
  const shared = {
    namespace: 'learnings',
    confidence: 0.9,
    projectId: 'project-a',
    scopeKind: 'path',
    triggerKind: 'file_edit',
    triggerSignature: 'rx_fifo',
    verificationState: 'verified',
    evidenceRef: 'test:path-scope',
    validUntil: Date.now() + 86_400_000,
  };
  store.writeMemory({
    ...shared,
    name: 'rtl-rx-fifo',
    content: 'rx fifo verified resolution for RTL path',
    sourceKey: 'repo-a:rtl-rx-fifo',
    pathScope: 'rtl/**',
  }, { db: wDb.db });
  store.writeMemory({
    ...shared,
    name: 'software-rx-fifo',
    content: 'rx fifo verified resolution for software path',
    sourceKey: 'repo-a:sw-rx-fifo',
    pathScope: 'sw/**',
  }, { db: wDb.db });

  const results = store.retrieveMemory('rx fifo verified resolution', {
    db: wDb.db,
    minConfidence: 0.7,
    trackHit: false,
    scope: {
      projectId: 'project-a',
      relativePath: 'rtl/rx_fifo.sv',
      triggerKind: 'file_edit',
      triggerSignature: 'rx_fifo',
    },
  });
  wDb.close();
  fs.rmSync(tempDir, { recursive: true, force: true });

  assert(results.length === 1 && results[0].name === 'rtl-rx-fifo',
    `out-of-path fact leaked into retrieval: ${JSON.stringify(results)}`);
});

test('memory retrieval enforces trigger contracts inside the selected scope', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-trigger-scope-'));
  const dbPath = path.join(tempDir, 'memory.db');
  const { openDb } = require(path.join(HOME, 'engine/sqlite/index.cjs'));
  const store = require(path.join(HOME, 'engine/sqlite/store-memory.cjs'));
  const wDb = openDb({ path: dbPath });
  const shared = {
    namespace: 'learnings',
    confidence: 0.9,
    projectId: 'project-a',
    scopeKind: 'repository',
    verificationState: 'verified',
    evidenceRef: 'test:trigger-scope',
    validUntil: Date.now() + 86_400_000,
  };
  store.writeMemory({
    ...shared,
    name: 'edit-rx-fifo',
    content: 'rx fifo verified resolution for file edit',
    sourceKey: 'repo-a:edit-rx-fifo',
    triggerKind: 'file_edit',
    triggerSignature: 'rx_fifo',
  }, { db: wDb.db });
  store.writeMemory({
    ...shared,
    name: 'timing-failure',
    content: 'rx fifo verified resolution for negative hold failure',
    sourceKey: 'repo-a:timing-failure',
    triggerKind: 'tool_failure',
    triggerSignature: 'negative_hold',
  }, { db: wDb.db });

  const results = store.retrieveMemory('rx fifo verified resolution', {
    db: wDb.db,
    minConfidence: 0.7,
    trackHit: false,
    scope: {
      projectId: 'project-a',
      relativePath: 'rtl/rx_fifo.sv',
      triggerKind: 'file_edit',
      triggerSignature: 'rx_fifo',
    },
  });
  wDb.close();
  fs.rmSync(tempDir, { recursive: true, force: true });

  assert(results.length === 1 && results[0].name === 'edit-rx-fifo',
    `out-of-trigger fact leaked into retrieval: ${JSON.stringify(results)}`);
});

test('memory retrieval injects only current verified facts by default', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-verification-scope-'));
  const dbPath = path.join(tempDir, 'memory.db');
  const { openDb } = require(path.join(HOME, 'engine/sqlite/index.cjs'));
  const store = require(path.join(HOME, 'engine/sqlite/store-memory.cjs'));
  const wDb = openDb({ path: dbPath });
  const shared = {
    namespace: 'learnings',
    confidence: 0.9,
    projectId: 'project-a',
    scopeKind: 'repository',
    triggerKind: 'file_edit',
    triggerSignature: 'rx_fifo',
  };
  const facts = [
    ['current-verified', 'verified', Date.now() + 86_400_000],
    ['unreviewed-candidate', 'candidate', Date.now() + 86_400_000],
    ['contract-changed', 'needs_reverify', Date.now() + 86_400_000],
    ['expired-verified', 'verified', Date.now() - 1_000],
  ];
  for (const [name, verificationState, validUntil] of facts) {
    store.writeMemory({
      ...shared,
      name,
      content: `rx fifo lifecycle contract ${name}`,
      sourceKey: `repo-a:${name}`,
      verificationState,
      evidenceRef: `test:${name}`,
      validUntil,
    }, { db: wDb.db });
  }
  const queryOptions = {
    db: wDb.db,
    minConfidence: 0.7,
    trackHit: false,
    scope: {
      projectId: 'project-a',
      relativePath: 'rtl/rx_fifo.sv',
      triggerKind: 'file_edit',
      triggerSignature: 'rx_fifo',
    },
  };
  const injected = store.retrieveMemory('rx fifo lifecycle contract', queryOptions);
  const review = store.retrieveMemory('rx fifo lifecycle contract', {
    ...queryOptions,
    includeCandidates: true,
  });
  wDb.close();
  fs.rmSync(tempDir, { recursive: true, force: true });

  assert(injected.length === 1 && injected[0].name === 'current-verified',
    `untrusted or stale fact entered automatic retrieval: ${JSON.stringify(injected)}`);
  assert(review.some((fact) => fact.name === 'unreviewed-candidate')
      && review.some((fact) => fact.name === 'contract-changed')
      && !review.some((fact) => fact.name === 'expired-verified'),
    `explicit review visibility is incorrect: ${JSON.stringify(review)}`);
});

test('memory source updates preserve applicability metadata when fields are omitted', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-update-scope-'));
  const dbPath = path.join(tempDir, 'memory.db');
  const { openDb } = require(path.join(HOME, 'engine/sqlite/index.cjs'));
  const store = require(path.join(HOME, 'engine/sqlite/store-memory.cjs'));
  const wDb = openDb({ path: dbPath });
  store.writeMemory({
    namespace: 'learnings',
    name: 'scoped-fact',
    content: 'original scoped fact',
    sourceKey: 'repo-a:scoped-fact',
    projectId: 'project-a',
    scopeKind: 'path',
    pathScope: 'rtl/**',
    triggerKind: 'file_edit',
    triggerSignature: 'rx_fifo',
    verificationState: 'verified',
    evidenceRef: 'test:original',
  }, { db: wDb.db });
  store.writeMemory({
    namespace: 'learnings',
    name: 'scoped-fact',
    content: 'updated scoped fact',
    sourceKey: 'repo-a:scoped-fact',
    description: 'content-only refresh',
  }, { db: wDb.db });
  const row = wDb.db.prepare(`
    SELECT project_id, scope_kind, path_scope, trigger_kind, trigger_signature,
           verification_state, evidence_ref
    FROM facts WHERE source_key = ?
  `).get('repo-a:scoped-fact');
  wDb.close();
  fs.rmSync(tempDir, { recursive: true, force: true });

  assert(row?.project_id === 'project-a' && row.scope_kind === 'path'
      && row.path_scope === 'rtl/**' && row.trigger_kind === 'file_edit'
      && row.trigger_signature === 'rx_fifo' && row.verification_state === 'verified'
      && row.evidence_ref === 'test:original',
    `partial source update erased applicability metadata: ${JSON.stringify(row)}`);
});

test('memory file reconciliation replaces stale applicability metadata from the authoritative snapshot', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-reconcile-scope-'));
  const dbPath = path.join(tempDir, 'memory.db');
  const sourcePath = path.join(tempDir, 'memory', 'learnings', 'scope.md');
  const { openDb } = require(path.join(HOME, 'engine/sqlite/index.cjs'));
  const store = require(path.join(HOME, 'engine/sqlite/store-memory.cjs'));
  const wDb = openDb({ path: dbPath });
  store.writeMemory({
    namespace: 'learnings',
    name: 'scope',
    content: 'old scoped content',
    sourceKey: 'learnings/scope.md',
    sourcePath,
    projectId: 'project-a',
    scopeKind: 'path',
    pathScope: 'rtl/**',
    triggerKind: 'user_query',
    triggerSignature: 'stale_signature',
    verificationState: 'verified',
    evidenceRef: 'test:old',
    contractHash: 'sha256:old',
    validUntil: Date.now() + 86_400_000,
  }, { db: wDb.db });
  store.reconcileMemoryFacts([{
    namespace: 'learnings',
    name: 'scope',
    content: 'new global content',
    description: 'authoritative file snapshot',
    source: 'migration:file',
    sourceKey: 'learnings/scope.md',
    sourcePath,
    projectId: null,
    scopeKind: 'global_harness',
    pathScope: null,
    triggerKind: 'user_query',
    triggerSignature: null,
    verificationState: 'verified',
    evidenceRef: 'test:new',
    contractHash: 'sha256:new',
    validUntil: Date.now() + 172_800_000,
  }], { db: wDb.db });
  const row = wDb.db.prepare(`
    SELECT content, project_id, scope_kind, path_scope, trigger_kind, trigger_signature,
           verification_state, evidence_ref, contract_hash
    FROM facts WHERE source_key = ?
  `).get('learnings/scope.md');
  wDb.close();
  fs.rmSync(tempDir, { recursive: true, force: true });

  assert(row?.content === 'new global content' && row.project_id === null
      && row.scope_kind === 'global_harness' && row.path_scope === null
      && row.trigger_kind === 'user_query' && row.trigger_signature === null
      && row.verification_state === 'verified' && row.evidence_ref === 'test:new'
      && row.contract_hash === 'sha256:new',
    `authoritative reconciliation preserved stale applicability metadata: ${JSON.stringify(row)}`);
});

test('memory retrieval handles PreToolUse Edit and Write file path payload shapes', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-pretool-'));
  const dbPath = path.join(tempDir, 'memory.db');
  const { openDb } = require(path.join(HOME, 'engine/sqlite/index.cjs'));
  const store = require(path.join(HOME, 'engine/sqlite/store-memory.cjs'));
  const projectScope = require(path.join(HOME, 'engine/scripts/lib/project-scope.cjs'));
  const wDb = openDb({ path: dbPath });
  store.writeMemory({
    namespace: 'learnings',
    name: 'rx-fifo',
    content: 'rx fifo HDL Verilog FSM timing interface verified lesson',
    confidence: 0.8,
    sourceKey: 'learnings/rx-fifo.md',
    sourcePath: path.join(tempDir, 'memory', 'learnings', 'rx-fifo.md'),
    projectId: projectScope.memoryProjectId(FIXTURE_REPO),
    scopeKind: 'repository',
    triggerKind: 'file_edit',
    triggerSignature: 'rx_fifo',
    verificationState: 'verified',
    evidenceRef: 'test:pretool-rx-fifo',
    validUntil: Date.now() + 86_400_000,
  }, { db: wDb.db });
  wDb.close();

  const hookPath = path.join(HOME, 'engine/scripts/memory-retrieve-hook.cjs');
  const env = {
    CLAUDE_SQLITE_PATH: dbPath,
    CLAUDE_MEMORY_HINT_CACHE_DISABLED: '1',
  };
  const edit = runNode(hookPath, JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Edit',
    session_id: 'edit-session',
    cwd: FIXTURE_REPO,
    tool_input: { file_path: `${FIXTURE_REPO}/rtl/rx_fifo.sv` },
  }), env);
  const write = runNode(hookPath, JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    session_id: 'write-session',
    cwd: FIXTURE_REPO,
    tool_input: { filePath: `${FIXTURE_REPO}/rtl/rx_fifo.sv` },
  }), env);
  const editOutput = edit.stdout ? JSON.parse(edit.stdout) : null;
  const writeOutput = write.stdout ? JSON.parse(write.stdout) : null;
  fs.rmSync(tempDir, { recursive: true, force: true });

  assert(edit.status === 0 && editOutput?.hookSpecificOutput?.hookEventName === 'PreToolUse'
      && editOutput.hookSpecificOutput.additionalContext.includes('rx-fifo'),
    `standard PreToolUse Edit payload did not inject context: ${edit.stderr || edit.stdout}`);
  assert(write.status === 0 && writeOutput?.hookSpecificOutput?.hookEventName === 'PreToolUse'
      && writeOutput.hookSpecificOutput.additionalContext.includes('rx-fifo'),
    `camelCase PreToolUse Write payload did not inject context: ${write.stderr || write.stdout}`);
});

test('memory retrieval exposes an injectable in-process context contract for preflight router', () => {
  const hook = require(path.join(HOME, 'engine/scripts/memory-retrieve-hook.cjs'));
  const queries = [];
  let cacheMarked = false;
  const deps = {
    doMemoryQuery(query, label) {
      queries.push({ query, label });
      return [{
        namespace: 'learnings', name: 'rx-fifo', summary: 'Use verified FIFO timing.',
        confidence: 0.8, source: 'reconcile:file', sourceKey: 'learnings/rx-fifo.md',
        status: 'active', updatedAt: 1722124800000,
      }];
    },
    recentlyInjected: () => false,
    markInjected() { cacheMarked = true; },
    resolveWikiLinks: () => ({ resolved: [] }),
  };
  const output = hook.retrieveContext({
    hook_event_name: 'PreToolUse',
    tool_name: 'Edit',
    session_id: 'router-session',
    cwd: FIXTURE_REPO,
    tool_input: { file_path: `${FIXTURE_REPO}/rtl/rx_fifo.sv` },
  }, deps);
  const miss = hook.retrieveContext({
    hook_event_name: 'PreToolUse',
    tool_name: 'Edit',
    session_id: 'router-session',
    cwd: FIXTURE_REPO,
    tool_input: { file_path: `${FIXTURE_REPO}/rtl/rx_fifo.sv` },
  }, { ...deps, doMemoryQuery: () => [] });

  assert(output?.hookSpecificOutput?.hookEventName === 'PreToolUse'
      && output.hookSpecificOutput.additionalContext.includes('rx-fifo'),
    `in-process retrieval contract missing: ${JSON.stringify(output)}`);
  assert(queries.length === 1 && queries[0].label === 'context'
      && queries[0].query.includes('rx') && cacheMarked,
    `router context query was not injectable/scoped: ${JSON.stringify({ queries, cacheMarked })}`);
  assert(miss === null, `in-process retrieval emitted empty context: ${JSON.stringify(miss)}`);
});

test('PreToolUse memory retrieval passes project path and trigger scope to the store', () => {
  const hook = require(path.join(HOME, 'engine/scripts/memory-retrieve-hook.cjs'));
  const projectScope = require(path.join(HOME, 'engine/scripts/lib/project-scope.cjs'));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-hook-scope-'));
  const repoRoot = path.join(tempDir, 'repo');
  const rtlDir = path.join(repoRoot, 'rtl');
  const filePath = path.join(rtlDir, 'rx_fifo.sv');
  fs.mkdirSync(rtlDir, { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'package.json'), '{}\n', 'utf8');
  fs.writeFileSync(filePath, 'module rx_fifo; endmodule\n', 'utf8');

  const receivedScopes = [];
  let output;
  try {
    output = hook.retrieveContext({
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      session_id: 'scope-passthrough-session',
      cwd: repoRoot,
      tool_input: { file_path: filePath },
    }, {
      openDb: () => ({ db: { marker: 'scope-db' }, close() {} }),
      retrieveMemorySummary(_query, options) {
        receivedScopes.push(options.scope);
        return [{
          namespace: 'learnings', name: 'rx-fifo',
          summary: 'rx fifo HDL Verilog FSM timing interface verified lesson',
          confidence: 0.9, source: 'test', source_key: 'repo:rx-fifo', status: 'active',
          updated_at: 1722124800000,
        }];
      },
      recentlyInjected: () => false,
      markInjected: () => {},
      resolveWikiLinks: () => ({ resolved: [] }),
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  const expected = {
    projectId: projectScope.memoryProjectId(repoRoot),
    relativePath: 'rtl/rx_fifo.sv',
    triggerKind: 'file_edit',
    triggerSignature: 'rx_fifo',
  };
  assert(output?.hookSpecificOutput?.additionalContext.includes('rx-fifo'),
    `scoped retrieval did not produce context: ${JSON.stringify(output)}`);
  // verified 层 (首次调用) 必须原样传递项目/路径/触发 scope
  assert(JSON.stringify(receivedScopes[0]) === JSON.stringify(expected),
    `PreToolUse scope was not passed to store retrieval: ${JSON.stringify(receivedScopes[0])}`);
  // 候选补位层继承同一 scope, 只额外放开 unscoped 存量 (D5 两层召回契约)
  for (const scope of receivedScopes.slice(1)) {
    assert(scope.projectId === expected.projectId
        && scope.relativePath === expected.relativePath
        && scope.triggerKind === expected.triggerKind
        && scope.triggerSignature === expected.triggerSignature
        && scope.allowUnscoped === true,
      `candidate tier scope drifted from PreToolUse scope: ${JSON.stringify(scope)}`);
  }
});

test('memory retrieval records only injected exposures through a separate managed database', () => {
  const hook = require(path.join(HOME, 'engine/scripts/memory-retrieve-hook.cjs'));
  const attribution = require(path.join(HOME, 'engine/sqlite/store-memory-attribution.cjs'));
  const sqlite = require(path.join(HOME, 'engine/sqlite/index.cjs'));
  const projectScope = require(path.join(HOME, 'engine/scripts/lib/project-scope.cjs'));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-exposure-hook-'));
  const repoRoot = path.join(tempDir, 'repo');
  const rtlDir = path.join(repoRoot, 'rtl');
  const filePath = path.join(rtlDir, 'rx_fifo.sv');
  const dbPath = path.join(tempDir, 'attribution.db');
  fs.mkdirSync(rtlDir, { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'package.json'), '{}\n', 'utf8');
  fs.writeFileSync(filePath, 'module rx_fifo; endmodule\n', 'utf8');
  const payload = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Edit',
    tool_use_id: 'tool-use-memory-exposure',
    session_id: 'memory-exposure-session',
    cwd: repoRoot,
    tool_input: { file_path: filePath, old_string: 'a', new_string: 'b' },
  };
  let queryClosed = false;
  let managedOpens = 0;
  const deps = {
    attributionPersistenceDisabled: () => false,
    openDb(options) {
      assert(options.readonly === true, 'retrieval query did not use a readonly connection');
      return { db: { marker: 'readonly-query-db' }, close() { queryClosed = true; } };
    },
    retrieveMemorySummary(_query, options) {
      assert(options.db.marker === 'readonly-query-db', 'retrieval used the wrong database');
      return [{
        id: 'fact-rx-fifo', namespace: 'learnings', name: 'rx-fifo',
        summary: 'rx fifo HDL Verilog FSM timing interface verified lesson',
        confidence: 0.91, source: 'reconcile:file', source_key: 'learnings/rx-fifo.md',
        status: 'active', updated_at: 1722124800000,
      }];
    },
    openAttributionDb(options = {}) {
      managedOpens += 1;
      assert(options.readonly !== true, 'attribution attempted to write through readonly DB');
      return sqlite.openDb({ path: dbPath });
    },
    recentlyInjected: () => false,
    markInjected: () => {},
    resolveWikiLinks: () => ({ resolved: [] }),
  };
  const previousCacheDisabled = process.env.CLAUDE_MEMORY_HINT_CACHE_DISABLED;
  process.env.CLAUDE_MEMORY_HINT_CACHE_DISABLED = '1';
  let output;
  try {
    output = hook.retrieveContext(payload, deps);
  } finally {
    if (previousCacheDisabled === undefined) delete process.env.CLAUDE_MEMORY_HINT_CACHE_DISABLED;
    else process.env.CLAUDE_MEMORY_HINT_CACHE_DISABLED = previousCacheDisabled;
  }
  const failOpen = hook.retrieveContext({ ...payload, tool_use_id: 'tool-use-write-failure' }, {
    ...deps,
    openAttributionDb() { throw new Error('fixture attribution DB unavailable'); },
  });

  const wDb = sqlite.openDb({ path: dbPath });
  const rows = wDb.db.prepare('SELECT * FROM memory_retrieval_exposures').all();
  wDb.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  assert(output?.hookSpecificOutput?.additionalContext.includes('rx-fifo')
      && failOpen?.hookSpecificOutput?.additionalContext.includes('rx-fifo'),
  'attribution write failure suppressed injected memory context');
  assert(queryClosed && managedOpens === 1, 'query and attribution DB lifecycles were not separated');
  assert(rows.length === 1, `expected one actually injected exposure, got ${JSON.stringify(rows)}`);
  const row = rows[0];
  assert(row.session_id === payload.session_id
      && row.project_id === projectScope.memoryProjectId(repoRoot)
      && row.memory_id === 'fact-rx-fifo'
      && Boolean(row.retrieval_id)
      && row.correlation_id === payload.tool_use_id,
  `retrieval identity chain is incomplete: ${JSON.stringify(row)}`);
  assert(row.trigger_kind === 'task-context' && row.rank === 1 && row.confidence === 0.91
      && row.target_path === 'rtl/rx_fifo.sv',
  `retrieval exposure metadata is incomplete: ${JSON.stringify(row)}`);
  assert(row.anchor_tool === 'Edit'
      && row.anchor_input_sha256 === attribution.toolInputSha256(payload),
  `PreToolUse anchor was not recorded: ${JSON.stringify(row)}`);
});

test('UserPrompt memory injection records a scoped exposure without a tool anchor', () => {
  const hook = require(path.join(HOME, 'engine/scripts/memory-retrieve-hook.cjs'));
  const sqlite = require(path.join(HOME, 'engine/sqlite/index.cjs'));
  const { memoryProjectId } = require(path.join(HOME, 'engine/scripts/lib/project-scope.cjs'));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-memory-exposure-'));
  const repoRoot = path.join(tempDir, 'repo');
  const dbPath = path.join(tempDir, 'attribution.db');
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'package.json'), '{}\n', 'utf8');
  const output = hook.retrieveContext({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'prompt-memory-exposure-session',
    cwd: repoRoot,
    prompt: 'How to fix rx fifo error using prior experience?',
  }, {
    attributionPersistenceDisabled: () => false,
    doMemoryQuery() {
      return [{
        memoryId: 'fact-prompt-rx-fifo', namespace: 'learnings', name: 'rx-fifo',
        summary: 'Use the verified rx fifo recovery sequence.', confidence: 0.88,
        source: 'reconcile:file', sourceKey: 'learnings/rx-fifo.md', status: 'active',
        updatedAt: 1722124800000,
      }];
    },
    openAttributionDb: () => sqlite.openDb({ path: dbPath }),
    recentlyInjected: () => false,
    markInjected: () => {},
  });
  const wDb = sqlite.openDb({ path: dbPath });
  const row = wDb.db.prepare('SELECT * FROM memory_retrieval_exposures').get();
  wDb.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  assert(output?.hookSpecificOutput?.additionalContext.includes('rx-fifo'),
    'UserPrompt retrieval was not actually injected');
  assert(row?.session_id === 'prompt-memory-exposure-session'
      && row.project_id === memoryProjectId(repoRoot)
      && row.memory_id === 'fact-prompt-rx-fifo'
      && row.trigger_kind === 'user-query',
  `UserPrompt exposure identity is incomplete: ${JSON.stringify(row)}`);
  assert(Boolean(row.retrieval_id) && row.correlation_id === row.retrieval_id
      && row.anchor_tool === null && row.anchor_input_sha256 === null,
  `UserPrompt exposure invented a tool anchor: ${JSON.stringify(row)}`);
});

test('in-process memory retrieval handles MultiEdit direct and edits-array paths', () => {
  const hook = require(path.join(HOME, 'engine/scripts/memory-retrieve-hook.cjs'));
  const queries = [];
  const deps = {
    doMemoryQuery(query, label) {
      queries.push({ query, label });
      return [{
        namespace: 'learnings', name: 'rx-fifo', summary: 'FIFO lesson', confidence: 0.8,
        source: 'reconcile:file', sourceKey: 'learnings/rx-fifo.md', status: 'active',
        updatedAt: 1722124800000,
      }];
    },
    recentlyInjected: () => false,
    markInjected: () => {},
    resolveWikiLinks: () => ({ resolved: [] }),
  };
  const direct = hook.retrieveContext({
    hook_event_name: 'PreToolUse', tool_name: 'MultiEdit', session_id: 'multi-direct', cwd: FIXTURE_REPO,
    tool_input: { file_path: `${FIXTURE_REPO}/rtl/rx_fifo.sv`, edits: [] },
  }, deps);
  const array = hook.retrieveContext({
    hook_event_name: 'PreToolUse', tool_name: 'MultiEdit', session_id: 'multi-array', cwd: FIXTURE_REPO,
    tool_input: { edits: [
      { file_path: `${FIXTURE_REPO}/README.md`, old_string: 'a', new_string: 'b' },
      { filePath: `${FIXTURE_REPO}/rtl/rx_fifo.sv`, old_string: 'a', new_string: 'b' },
    ] },
  }, deps);

  assert(direct?.hookSpecificOutput?.additionalContext.includes('rx-fifo'),
    `MultiEdit direct path produced no context: ${JSON.stringify(direct)}`);
  assert(array?.hookSpecificOutput?.additionalContext.includes('rx-fifo'),
    `MultiEdit edits array produced no context: ${JSON.stringify(array)}`);
  assert(queries.length === 2 && queries.every(item => item.label === 'context'
      && item.query.includes('rx') && item.query.includes('fifo')),
    `MultiEdit did not select its first code file: ${JSON.stringify(queries)}`);
});

test('cross-link retrieval uses only the fresh failure payload without hit or signal loops', () => {
  const crossLink = require(path.join(HOME, 'engine/scripts/cross-link-memory.cjs'));
  const source = fs.readFileSync(path.join(HOME, 'engine/scripts/cross-link-memory.cjs'), 'utf8');
  const sqlite = require(path.join(HOME, 'engine/sqlite/index.cjs'));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-link-exposure-'));
  const dbPath = path.join(tempDir, 'attribution.db');
  const db = { marker: 'readonly-cross-link' };
  const calls = [];
  let closed = false;
  let managedOpens = 0;
  const deps = {
    attributionPersistenceDisabled: () => false,
    now: () => 1722124800000,
    openDb(options) {
      assert(options.readonly === true, 'cross-link did not request a readonly DB');
      return { db, close() { closed = true; } };
    },
    retrieveMemory(query, options) {
      calls.push({ query, options });
      return options.namespaces[0] === 'errors' ? [{
        id: 'fact-negative-hold',
        name: 'negative-hold',
        description: 'Negative hold slack after route is a timing failure.',
        confidence: 0.9,
        source: 'reconcile:file',
        source_key: 'errors/negative-hold.md',
        status: 'active',
        updated_at: 1722124700000,
      }] : [];
    },
    openAttributionDb(options = {}) {
      managedOpens += 1;
      assert(options.readonly !== true, 'cross-link attribution reused readonly DB');
      return sqlite.openDb({ path: dbPath });
    },
  };
  const failurePayload = {
    hook_event_name: 'PostToolUseFailure',
    tool_use_id: 'tool-use-negative-hold',
    session_id: 'failure-session',
    cwd: FIXTURE_REPO,
    timestamp: 1722124799000,
    tool_name: 'Bash',
    tool_input: { command: 'vivado -mode batch -source route.tcl' },
    tool_response: { status: 1, stderr: 'ERROR: negative hold slack -0.163 ns' },
  };
  const output = crossLink.evaluatePayload(failurePayload, deps);
  const writeFailure = crossLink.evaluatePayload({
    ...failurePayload,
    tool_use_id: 'tool-use-negative-hold-writer-failure',
  }, {
    ...deps,
    openAttributionDb() { throw new Error('fixture cross-link attribution unavailable'); },
  });
  const stale = crossLink.evaluatePayload({
    hook_event_name: 'PostToolUseFailure',
    session_id: 'failure-session',
    timestamp: 1722120000000,
    tool_name: 'Bash',
    tool_response: { status: 1, stderr: 'old failure' },
  }, deps);

  const wDb = sqlite.openDb({ path: dbPath });
  const exposureRows = wDb.db.prepare('SELECT * FROM memory_retrieval_exposures').all();
  wDb.close();
  fs.rmSync(tempDir, { recursive: true, force: true });

  assert(output?.hookSpecificOutput?.hookEventName === 'PostToolUseFailure'
      && output.hookSpecificOutput.additionalContext.includes('negative-hold'),
    `failure memory was not injected as hook context: ${JSON.stringify(output)}`);
  assert(writeFailure?.hookSpecificOutput?.additionalContext.includes('negative-hold'),
    'cross-link attribution writer failure suppressed failure context');
  assert(calls.length === 4 && calls.every(call => call.options.db === db
      && call.options.trackHit === false),
    `cross-link query mutated retrieval state: ${JSON.stringify(calls)}`);
  const { memoryProjectId } = require(path.join(HOME, 'engine/scripts/lib/project-scope.cjs'));
  assert(calls.every((call) => call.options.scope?.projectId === memoryProjectId(FIXTURE_REPO)
      && call.options.scope?.triggerKind === 'tool_failure'
      && call.options.scope?.triggerSignature === 'negative_hold_slack'),
    `cross-link did not hard-scope the failure signature: ${JSON.stringify(calls)}`);
  const errorCall = calls.find(call => call.options.namespaces[0] === 'errors');
  const learningCall = calls.find(call => call.options.namespaces[0] === 'learnings');
  assert(errorCall.options.minConfidence >= 0.8 && learningCall.options.minConfidence >= 0.7,
    `cross-link admitted unverified memories: ${JSON.stringify(calls)}`);
  assert(calls[0].query.includes('negative hold slack') && closed,
    `current failure payload did not drive and close retrieval: ${JSON.stringify(calls)}`);
  assert(managedOpens === 1 && exposureRows.length === 1,
    `failure injection did not use one managed attribution DB: ${JSON.stringify(exposureRows)}`);
  const exposure = exposureRows[0];
  assert(exposure.session_id === failurePayload.session_id
      && exposure.project_id === memoryProjectId(FIXTURE_REPO)
      && exposure.memory_id === 'fact-negative-hold'
      && Boolean(exposure.retrieval_id)
      && exposure.correlation_id === failurePayload.tool_use_id,
  `failure exposure identity chain is incomplete: ${JSON.stringify(exposure)}`);
  const attribution = require(path.join(HOME, 'engine/sqlite/store-memory-attribution.cjs'));
  assert(exposure.trigger_kind === 'tool-failure' && exposure.rank === 1
      && exposure.confidence === 0.9 && exposure.anchor_tool === 'Bash'
      && exposure.anchor_input_sha256 === attribution.toolInputSha256(failurePayload),
  `failure exposure metadata is incomplete: ${JSON.stringify(exposure)}`);
  assert(stale === null, 'stale failure payload still triggered memory retrieval');
  assert(!source.includes('signal-collector.cjs') && !source.includes("emitSync('memory_cross_ref'")
      && !source.includes('runtime-state.json'),
    'cross-link still contains a self-reinforcing signal or stale runtime-state loop');
});

test('postflight records causal lifecycle events and refuses anonymous telemetry', () => {
  const observer = require(path.join(HOME, 'engine/hooks/learning/postflight-observer.cjs'));
  let anonymousOpens = 0;
  const anonymous = observer.handlePayload({
    hook_event_name: 'PostToolUseFailure',
    tool_name: 'Bash',
    tool_response: { status: 1, stderr: 'anonymous failure' },
  }, {
    openDb() { anonymousOpens += 1; throw new Error('anonymous event opened DB'); },
  });
  assert(observer.sessionIdFrom({}) === '' && anonymous.actions.length === 0 && anonymousOpens === 0,
    `anonymous event was assigned synthetic identity: ${JSON.stringify({ anonymous, anonymousOpens })}`);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'postflight-causal-'));
  const dbPath = path.join(tempDir, 'causal.db');
  const correction = observer.handlePayload({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'causal-session',
    prompt: "不对，S_CFG 应该是 4'd1，而不是 4'd2。",
    cwd: FIXTURE_REPO,
  }, { dbPath });
  const verification = observer.handlePayload({
    hook_event_name: 'PostToolUse',
    session_id: 'causal-session',
    tool_name: 'Bash',
    tool_input: { command: 'node tests/run-focused-regression.cjs' },
    tool_response: { status: 0, stdout: '12/12 passed', stderr: '' },
  }, { dbPath });
  const resolution = observer.handlePayload({
    hook_event_name: 'Stop',
    session_id: 'causal-session',
    learning_event: {
      type: 'resolution',
      rootCause: 'state encoding was copied incorrectly',
      fix: "use exact S_CFG=4'd1 encoding",
      verification: { command: 'node tests/run-focused-regression.cjs', evidence: '12/12 passed' },
    },
  }, { dbPath });

  const { openDb } = require(path.join(HOME, 'engine/sqlite/index.cjs'));
  const wDb = openDb({ path: dbPath });
  const rows = wDb.db.prepare(
    'SELECT type, payload FROM runtime_events ORDER BY event_id',
  ).all().map(row => ({ type: row.type, payload: JSON.parse(row.payload) }));
  wDb.close();
  fs.rmSync(tempDir, { recursive: true, force: true });

  assert(correction.actions.includes('signal:user_correct')
      && verification.actions.includes('signal:verification_pass')
      && resolution.actions.includes('signal:resolution'),
    `causal routes missing: ${JSON.stringify({ correction, verification, resolution })}`);
  assert(rows.map(row => row.type).join(',') === 'user_correct,verification_pass,resolution',
    `causal event sequence incorrect: ${JSON.stringify(rows)}`);
  assert(rows[0].payload.correction.includes("S_CFG")
      && rows[1].payload.command.includes('focused-regression')
      && rows[1].payload.evidence === '12/12 passed'
      && rows[2].payload.rootCause.includes('state encoding')
      && rows[2].payload.fix.includes("4'd1")
      && rows[2].payload.verification.evidence === '12/12 passed',
    `causal payload lacks correction/fix/verification evidence: ${JSON.stringify(rows)}`);
});

test('PostToolUseFailure routes shell failures through verification and health gates', () => {
  const settingsFile = path.join(HOME, 'settings.json');
  const entries = collectHookEntries({ files: [settingsFile] })
    .filter(entry => entry.point === 'PostToolUseFailure'
      && entry.command.includes('postflight-router.cjs'));

  assert(entries.length === 1 && entries[0].matcher === '*',
    `expected one all-tool failure router, found ${entries.length}`);
  const command = entries[0].command;
  assert(command.includes('postflight-router.cjs'), 'PostToolUseFailure route is not the state router');

  const missing = validateHookScripts({ files: [settingsFile] }).missing
    .filter(record => record.command === command);
  assert(missing.length === 0, `failure route has missing scripts: ${missing.map(item => item.source).join(', ')}`);
});

test('harness CI recognizes PostToolUseFailure as a real hook lifecycle event', () => {
  const source = fs.readFileSync(path.join(HOME, 'engine/scripts/harness-ci.cjs'), 'utf8');
  const block = source.match(/const VALID_HOOK_EVENTS = new Set\(\[([\s\S]*?)\]\);/);
  assert(block, 'harness-ci VALID_HOOK_EVENTS declaration is missing');
  assert(/['"]PostToolUseFailure['"]/.test(block[1]),
    'harness-ci rejects the registered PostToolUseFailure lifecycle event');
});

test('SessionStart routes lifecycle sources precisely and leaves dormant ECC bridges disabled', () => {
  const settingsFile = path.join(HOME, 'settings.json');
  const entries = collectHookEntries({ files: [settingsFile] });
  const starts = entries.filter(entry => entry.point === 'SessionStart');

  assert(starts.length > 0, 'SessionStart has no registered hooks');
  assert(!starts.some(entry => entry.matcher === '*'), 'SessionStart wildcard still replays every hook');
  assert(!entries.some(entry => /resolve-plugin-path\.sh|stop-runner\.cjs/.test(entry.command)),
    'dormant ECC bridge is still on an active lifecycle path');

  const bootstrap = starts.filter(entry => entry.command.includes('session-bootstrap.cjs'));
  assert(bootstrap.length === 1 && !bootstrap[0].isAsync,
    `expected one synchronous SessionStart bootstrap, found ${bootstrap.length}`);
  for (const source of ['startup', 'resume', 'clear', 'compact', 'fork']) {
    assert(bootstrap[0].matcher.split('|').includes(source), `${source} route is missing from session bootstrap`);
  }
  assert(!starts.some(entry => /state-resume\.cjs|context-resume\.cjs|dream-startup-inject\.cjs|isolation-check\.cjs/.test(entry.command)),
    'a SessionStart component still launches as an independent process');

  const maintenance = [
    'memory-health-check.cjs',
    'kb-stats.cjs',
    'eda-detect.cjs',
    'memory-health-score.sh',
  ];
  for (const entry of starts) {
    if (maintenance.some(script => entry.command.includes(script))) {
      assert(entry.matcher === 'startup', `heavy startup hook leaked into ${entry.matcher}: ${entry.command}`);
    }
  }
});

test('local runner enforces one batch deadline and reports structured timeout state', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-runner-deadline-'));
  const first = path.join(tempDir, 'first.cjs');
  const second = path.join(tempDir, 'second.cjs');
  const runner = path.join(HOME, 'engine/scripts/hooks/local-runner.cjs');
  fs.writeFileSync(first, 'setTimeout(() => process.exit(0), 180);\n', 'utf8');
  fs.writeFileSync(second, 'setTimeout(() => process.exit(0), 180);\n', 'utf8');

  const started = Date.now();
  const result = spawnSync(process.execPath, [
    runner,
    '--batch',
    `${first},${second}`,
    '--deadline-ms',
    '280',
  ], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git status' } }),
    encoding: 'utf8',
    timeout: 3000,
    windowsHide: true,
  });
  const elapsed = Date.now() - started;
  fs.rmSync(tempDir, { recursive: true, force: true });

  assert(result.status !== 0, `batch ignored its total deadline, exit=${result.status}, elapsed=${elapsed}ms`);
  assert(elapsed < 650, `batch deadline behaved like a per-child timeout, elapsed=${elapsed}ms`);
  assert(result.stderr.includes('"timedOut":true'), `structured timeout flag missing: ${result.stderr}`);
  assert(result.stderr.includes('"errorCode":"HOOK_DEADLINE_EXCEEDED"'),
    `structured timeout code missing: ${result.stderr}`);
});

test('local runner deadline cancels descendant processes before they outlive the hook', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-runner-tree-'));
  const ready = path.join(tempDir, 'child-ready.txt');
  const marker = path.join(tempDir, 'orphan-marker.txt');
  const hook = path.join(tempDir, 'spawn-child.cjs');
  const runner = path.join(HOME, 'engine/scripts/hooks/local-runner.cjs');
  const childCode = [
    `require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready');`,
    `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'orphan'), 1000);`,
  ].join('');
  fs.writeFileSync(hook, [
    "const { spawn } = require('node:child_process');",
    `spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { windowsHide: true });`,
    'setTimeout(() => process.exit(0), 5000);',
    '',
  ].join('\n'), 'utf8');

  const result = spawnSync(process.execPath, [runner, hook, '--deadline-ms', '600'], {
    input: '{}',
    encoding: 'utf8',
    timeout: 3000,
    windowsHide: true,
  });
  const childStarted = fs.existsSync(ready);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);
  const orphaned = fs.existsSync(marker);
  fs.rmSync(tempDir, { recursive: true, force: true });

  assert(result.status !== 0, `deadline did not terminate the parent hook, exit=${result.status}`);
  assert(childStarted, 'process-tree fixture never started its descendant process');
  assert(!orphaned, 'deadline left a descendant process running after the hook exited');
});

test('local-runner remains tested but is retired from active hook paths', () => {
  const settingsFile = path.join(HOME, 'settings.json');
  const entries = collectHookEntries({ files: [settingsFile] })
    .filter(entry => entry.command.includes('local-runner.cjs'));

  assert(entries.length === 0, `local-runner remains active: ${entries[0]?.command}`);
  assert(fs.existsSync(path.join(HOME, 'engine/scripts/hooks/local-runner.cjs')),
    'local-runner helper was deleted instead of retained for explicit compatibility tests');
});

test('hook benchmark counts a nonzero exit status as a failed sample', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-bench-exit-'));
  const failingHook = path.join(tempDir, 'fail.cjs');
  fs.writeFileSync(failingHook, 'process.exit(7);\n', 'utf8');
  const { benchHook } = require(path.join(HOME, 'engine/scripts/lib/bench-hooks.cjs'));
  const result = benchHook(`node "${failingHook}"`, 'failing-hook', false);
  fs.rmSync(tempDir, { recursive: true, force: true });

  assert(result.status === 7, `fixture did not exit 7, status=${result.status}`);
  assert(result.ok === false, 'benchmark reported a nonzero hook exit as ok');
});

test('hook benchmark records one cold sample and repeated warm samples', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-bench-samples-'));
  const hook = path.join(tempDir, 'pass.cjs');
  fs.writeFileSync(hook, 'process.exit(0);\n', 'utf8');
  const { benchHook } = require(path.join(HOME, 'engine/scripts/lib/bench-hooks.cjs'));
  const result = benchHook(`node "${hook}"`, 'sampled-hook', false, {
    warmupRuns: 1,
    sampleRuns: 3,
  });
  fs.rmSync(tempDir, { recursive: true, force: true });

  assert(result.cold && result.cold.ok === true, 'cold benchmark sample is missing or failed');
  assert(result.warmupRuns === 1, `warmup count mismatch: ${result.warmupRuns}`);
  assert(Array.isArray(result.warmSamples) && result.warmSamples.length === 3,
    `expected three warm samples, got ${result.warmSamples?.length}`);
  assert(result.warmSamples.every(sample => sample.ok), 'a warm benchmark sample failed');
});

test('hook benchmark redirects harness state writes into a disposable sandbox', () => {
  const bench = require(path.join(HOME, 'engine/scripts/lib/bench-hooks.cjs'));
  assert(typeof bench.createBenchSandbox === 'function', 'benchmark sandbox factory is missing');
  const sandbox = bench.createBenchSandbox();
  const probeName = `bench-probe-${process.pid}-${Date.now()}.txt`;
  const productionProbe = path.join(HOME, 'var', probeName);
  const sandboxProbe = path.join(sandbox.root, 'var', probeName);
  const hook = path.join(sandbox.base, 'write-probe.cjs');
  fs.writeFileSync(hook, [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const target = path.join(process.env.CLAUDE_HARNESS_ROOT, 'var', process.env.BENCH_PROBE);",
    "fs.mkdirSync(path.dirname(target), { recursive: true });",
    "fs.writeFileSync(target, 'sandboxed');",
    '',
  ].join('\n'), 'utf8');

  const result = bench.benchHook(`node "${hook}"`, 'sandbox-probe', false, {
    warmupRuns: 0,
    sampleRuns: 1,
    cwd: sandbox.root,
    env: { ...sandbox.env, BENCH_PROBE: probeName },
  });
  const sandboxed = fs.existsSync(sandboxProbe);
  const productionTouched = fs.existsSync(productionProbe);
  sandbox.cleanup();

  assert(result.ok, `sandbox probe hook failed: ${result.error || result.status}`);
  assert(sandboxed, 'benchmark sample did not write into its sandbox state root');
  assert(!productionTouched, 'benchmark sample touched the production var directory');
});

test('benchmark entry runner always sandboxes sync hooks and never executes async hooks', () => {
  const bench = require(path.join(HOME, 'engine/scripts/lib/bench-hooks.cjs'));
  assert(typeof bench.benchmarkEntries === 'function', 'benchmark entry runner is missing');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-bench-entry-'));
  const syncHook = path.join(tempDir, 'sync.cjs');
  const asyncHook = path.join(tempDir, 'async.cjs');
  const syncProbe = `bench-sync-${process.pid}-${Date.now()}.txt`;
  const asyncProbe = `bench-async-${process.pid}-${Date.now()}.txt`;
  fs.writeFileSync(syncHook, [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `fs.mkdirSync(path.join(process.env.CLAUDE_HARNESS_ROOT, 'var'), { recursive: true });`,
    `fs.writeFileSync(path.join(process.env.CLAUDE_HARNESS_ROOT, 'var', ${JSON.stringify(syncProbe)}), 'sync');`,
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(asyncHook,
    `require('node:fs').writeFileSync(${JSON.stringify(path.join(HOME, 'var', asyncProbe))}, 'async');\n`,
    'utf8');

  const outcome = bench.benchmarkEntries([
    { point: 'PreToolUse', cmd: `node "${syncHook}"`, id: 'sync', isAsync: false },
    { point: 'PostToolUse', cmd: `node "${asyncHook}"`, id: 'async', isAsync: true },
  ], { warmupRuns: 0, sampleRuns: 1 });
  fs.rmSync(tempDir, { recursive: true, force: true });

  assert(outcome.results[0].ok, `sandboxed sync hook failed: ${outcome.results[0].error}`);
  assert(outcome.results[1].skipped && outcome.results[1].isAsync,
    'async hook was not skipped by the benchmark runner');
  assert(!fs.existsSync(path.join(HOME, 'var', syncProbe)), 'sync benchmark touched production state');
  assert(!fs.existsSync(path.join(HOME, 'var', asyncProbe)), 'async benchmark was executed');
});

test('benchmark entry runner replays lifecycle-specific real payload shapes', () => {
  const bench = require(path.join(HOME, 'engine/scripts/lib/bench-hooks.cjs'));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-bench-payload-'));
  const makeCapture = (name) => {
    const script = path.join(tempDir, `${name}.cjs`);
    const output = path.join(tempDir, `${name}.json`);
    fs.writeFileSync(script, [
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(output)}, fs.readFileSync(0, 'utf8'));`,
      '',
    ].join('\n'), 'utf8');
    return { script, output };
  };
  const prompt = makeCapture('prompt');
  const startup = makeCapture('startup');
  const stop = makeCapture('stop');
  bench.benchmarkEntries([
    { point: 'UserPromptSubmit', matcher: '*', cmd: `node "${prompt.script}"`, id: 'prompt', isAsync: false },
    { point: 'SessionStart', matcher: 'startup', cmd: `node "${startup.script}"`, id: 'startup', isAsync: false },
    { point: 'Stop', matcher: '*', cmd: `node "${stop.script}"`, id: 'stop', isAsync: false },
  ], { warmupRuns: 0, sampleRuns: 1 });
  const promptPayload = readJson(prompt.output, {});
  const startupPayload = readJson(startup.output, {});
  const stopPayload = readJson(stop.output, {});
  fs.rmSync(tempDir, { recursive: true, force: true });

  assert(promptPayload.hook_event_name === 'UserPromptSubmit' && promptPayload.prompt,
    `UserPromptSubmit payload mismatch: ${JSON.stringify(promptPayload)}`);
  assert(startupPayload.hook_event_name === 'SessionStart' && startupPayload.source === 'startup',
    `SessionStart payload mismatch: ${JSON.stringify(startupPayload)}`);
  assert(stopPayload.hook_event_name === 'Stop' && stopPayload.last_assistant_message,
    `Stop payload mismatch: ${JSON.stringify(stopPayload)}`);
});

test('local permissions allow edits without bypassing all shell approvals', () => {
  const local = readJson(path.join(HOME, 'settings.local.json'), {});
  const permissions = local.permissions || {};
  const allow = new Set(permissions.allow || []);
  const ask = new Set(permissions.ask || []);

  assert(permissions.defaultMode === 'acceptEdits',
    `defaultMode must be acceptEdits, got ${permissions.defaultMode}`);
  assert(!allow.has('Bash') && !allow.has('PowerShell'), 'shell tools are still unconditionally allowed');
  assert(allow.has('Read') && allow.has('Write') && allow.has('Edit'),
    'read/edit continuity was lost while tightening shell permissions');
  assert(ask.has('Bash(git commit:*)') && ask.has('Bash(git push:*)'),
    'external Git mutations no longer require explicit approval');
});

test('local settings do not force context compaction below fifty percent', () => {
  const local = readJson(path.join(HOME, 'settings.local.json'), {});
  const raw = local.env?.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
  assert(raw === undefined || Number(raw) >= 50,
    `low autocompact override still amplifies SessionStart(compact): ${raw}`);
  // settings.json 不入版本库（hook 命令含本机绝对路径，见 engine/hooks/registrations.json）。
  // 全新 checkout / CI 上它要么不存在，要么只有渲染器生成的 hooks 块 —— model/effortLevel
  // 是操作员的本机选择，不是仓库契约，那里没有"正确值"可断言。
  const settingsPath = path.join(HOME, 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    skip('settings.json 不存在（全新 checkout / CI）——本机 model/effort 断言不适用');
  }
  const base = readJson(settingsPath, {});
  const keys = Object.keys(base);
  if (keys.length === 1 && keys[0] === 'hooks') {
    skip('settings.json 由 render-hook-settings.cjs 生成，未含本机 model/effort 配置');
  }
  // 已批准的本机模型选择:opus[1m](原基线)与 claude-fable-5[1m](2026-07-29 操作员显式
  // /model 切换,允许两者间 A/B)。出现第三个值仍视为无决策记录的漂移。
  const sanctionedModels = ['opus[1m]', 'claude-fable-5[1m]'];
  // effortLevel 同理:此前钉死成单值 'max',但上面那段注释自己已经写明"model/effortLevel
  // 是操作员的本机选择,那里没有正确值可断言"—— 注释与断言互相矛盾,而矛盾的那一侧是
  // 断言。2026-08-02 实测:操作员切到 xhigh 后本条与 E2E 同时变红,而这是一次合理的
  // 本机选择。把本机偏好钉进契约,只会训练人忽略红灯。改为与 model 同构的白名单:
  // 锁的是"没有决策记录的漂移",不是"不许换"。
  const sanctionedEfforts = ['max', 'xhigh'];
  assert(sanctionedModels.includes(base.model) && sanctionedEfforts.includes(base.effortLevel),
    `model/effort ${base.model}/${base.effortLevel} is not a sanctioned choice `
    + `(${sanctionedModels.join(' / ')} × ${sanctionedEfforts.join(' / ')}) — record A/B evidence before pinning a new one`);
});

test('local plugins do not inject a second full skill router at SessionStart', () => {
  const local = readJson(path.join(HOME, 'settings.local.json'), {});
  // 这半条是真正的仓库契约：settings.local.json 入库，插件是否启用可以被断言。
  assert(local.enabledPlugins?.['superpowers@claude-plugins-official'] !== true,
    'superpowers still adds a duplicate using-superpowers SessionStart hook');
  // 这半条不是：var/ 是 .gitignore 的本机运行时目录，全新 checkout / CI 上必然没有，
  // "缓存还在不在" 只有本机答得上来。
  if (!fs.existsSync(path.join(HOME, 'var/plugins'))) {
    skip('var/plugins 不存在（全新 checkout / CI）——本机插件缓存断言不适用');
  }
  assert(fs.existsSync(path.join(HOME, 'var/plugins/cache/claude-plugins-official/superpowers')),
    'superpowers cache was deleted instead of only disabling the plugin');
});

test('local runner gate bypass is short-lived, session-bound, target-exact, and redacted', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-runner-bypass-'));
  const marker = path.join(tempDir, 'executed.txt');
  const audit = path.join(tempDir, 'audit.jsonl');
  const hook = path.join(tempDir, 'target.cjs');
  const runner = path.join(HOME, 'engine/scripts/hooks/local-runner.cjs');
  const sessionId = 'runner-session-bound';
  const reason = 'approved recovery for a stale verification gate';
  const actor = 'operator-lihan';
  const issuedAt = Date.now();
  fs.writeFileSync(hook,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');\n`,
    'utf8');

  const cleanEnv = () => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith('CLAUDE_GATES_DISABLE')) delete env[key];
    }
    return env;
  };

  const invalid = spawnSync(process.execPath, [runner, hook], {
    input: JSON.stringify({ session_id: sessionId }),
    encoding: 'utf8',
    timeout: 3000,
    windowsHide: true,
    env: {
      ...cleanEnv(),
      CLAUDE_GATES_DISABLED: 'true',
      CLAUDE_GATES_DISABLE_AUDIT_PATH: audit,
    },
  });
  const invalidExecuted = fs.existsSync(marker);
  if (invalidExecuted) fs.unlinkSync(marker);

  const valid = spawnSync(process.execPath, [runner, hook], {
    input: JSON.stringify({ session_id: sessionId }),
    encoding: 'utf8',
    timeout: 3000,
    windowsHide: true,
    env: {
      ...cleanEnv(),
      CLAUDE_GATES_DISABLED: '1',
      CLAUDE_GATES_DISABLE_REASON: reason,
      CLAUDE_GATES_DISABLE_ACTOR: actor,
      CLAUDE_GATES_DISABLE_TARGET: path.basename(hook),
      CLAUDE_GATES_DISABLE_SESSION: sessionId,
      CLAUDE_GATES_DISABLE_ISSUED_AT: String(issuedAt),
      CLAUDE_GATES_DISABLE_TTL_MS: '60000',
      CLAUDE_GATES_DISABLE_AUDIT_PATH: audit,
    },
  });
  const validExecuted = fs.existsSync(marker);
  const auditText = fs.existsSync(audit) ? fs.readFileSync(audit, 'utf8') : '';
  fs.rmSync(tempDir, { recursive: true, force: true });

  assert(invalid.status === 0 && invalidExecuted,
    'unaudited bypass still skipped the target instead of running its gate');
  assert(valid.status === 0 && !validExecuted, 'audited exact-target bypass did not skip its target');
  assert(auditText.trim().split(/\r?\n/).length === 2, `expected two audit decisions: ${auditText}`);
  assert(auditText.includes('"decision":"rejected"') && auditText.includes('"decision":"allowed"'),
    `audit decisions missing: ${auditText}`);
  assert(!auditText.includes(reason) && !auditText.includes(actor) && !auditText.includes(sessionId),
    'bypass audit leaked raw authorization identity');
});

test('local runner child environment preserves runtime context without inheriting unrelated secrets', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-runner-env-'));
  const output = path.join(tempDir, 'env.json');
  const hook = path.join(tempDir, 'capture.cjs');
  const runner = path.join(HOME, 'engine/scripts/hooks/local-runner.cjs');
  fs.writeFileSync(hook, [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify({`,
    '  github: process.env.GITHUB_TOKEN || null,',
    '  claudeOauth: process.env.CLAUDE_CODE_OAUTH_TOKEN || null,',
    '  anthropic: process.env.ANTHROPIC_API_KEY || null,',
    '  path: process.env.PATH || process.env.Path || null,',
    '  session: process.env.CLAUDE_SESSION_ID || null,',
    '}));',
    '',
  ].join('\n'), 'utf8');
  const result = spawnSync(process.execPath, [runner, hook], {
    input: JSON.stringify({ session_id: 'payload-session' }),
    encoding: 'utf8',
    timeout: 3000,
    windowsHide: true,
    env: {
      ...process.env,
      GITHUB_TOKEN: 'sentinel-must-not-reach-hook',
      CLAUDE_CODE_OAUTH_TOKEN: 'sentinel-oauth-must-not-reach-hook',
      ANTHROPIC_API_KEY: 'sentinel-api-key-must-not-reach-hook',
      CLAUDE_SESSION_ID: 'claude-session-preserved',
    },
  });
  const captured = readJson(output, {});
  fs.rmSync(tempDir, { recursive: true, force: true });

  assert(result.status === 0, `environment fixture hook failed: ${result.stderr}`);
  assert(captured.github === null, 'runner leaked GITHUB_TOKEN into a child gate');
  assert(captured.claudeOauth === null, 'runner leaked CLAUDE_CODE_OAUTH_TOKEN into a child gate');
  assert(captured.anthropic === null, 'runner leaked ANTHROPIC_API_KEY into a child gate');
  assert(captured.path, 'runner stripped PATH required to execute toolchain probes');
  assert(captured.session === 'claude-session-preserved', 'runner stripped Claude session context');
});

// 契约变更 (刻意): 这两道门禁已从 exit 2 硬阻断降级为结构化 Hook advisory。
// 它们唯一的放行条件是模型自己写一份 status:"completed" 的 JSON(无 schema、
// 无有效期、无写保护), 阻断只会诱导伪造门禁记录, 并对临时脚本大量误报。
// 但**作用域隔离本身仍必须成立**: 属于别的项目的 completed 状态不得被当作
// 本项目已澄清 —— 因此这里断言"仍然识别为未完成并通过 additionalContext 提示", 而不是
// 断言退出码。真正的硬门禁见 hdl-coding-dag-workflow.js 的 Phase 4.5
// (校验 check_results/<mod>.json 真实存在且 status===PASS)。
test('requirements gate does not honor completed state scoped to another project', () => {
  const stateFile = path.join(HOME, 'var/gates/requirements-gate.json');
  const guard = path.join(HOME, 'engine/scripts/hooks/requirements-gate-guard.cjs');
  const target = path.join(os.tmpdir(), `harness-unrelated-${Date.now()}`, 'new_module.py');

  withFileBackup(stateFile, () => {
    fs.writeFileSync(stateFile, JSON.stringify({
      status: 'completed',
      task: 'old unrelated FPGA task',
      projectRoot: path.join(os.tmpdir(), 'old-project'),
      completedAt: '2026-01-01T00:00:00.000Z',
    }, null, 2));

    const payload = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: target },
    });
    const r = runNode(guard, payload);
    assert(r.status === 0, `advisory gate must not block, exit=${r.status}`);
    const hookOutput = JSON.parse(r.stdout);
    const advisory = JSON.parse(hookOutput.hookSpecificOutput.additionalContext);
    assert(advisory.source === 'requirements-gate' && advisory.status === 'warning' && advisory.blocking === false,
      `stale cross-project state was silently honored (no advisory emitted), stdout=${r.stdout.slice(0, 200)}`);
  });
});

test('verification quality gate does not honor completed state scoped to another project', () => {
  const stateFile = path.join(HOME, 'var/gates/verification-quality.json');
  const guard = path.join(HOME, 'engine/scripts/hooks/verification-quality-guard.cjs');
  const target = path.join(os.tmpdir(), `harness-unrelated-${Date.now()}`, 'tb_new_module.sv');

  withFileBackup(stateFile, () => {
    fs.writeFileSync(stateFile, JSON.stringify({
      status: 'completed',
      module: 'old_module',
      projectRoot: path.join(os.tmpdir(), 'old-project'),
      completedAt: '2026-01-01T00:00:00.000Z',
    }, null, 2));

    const payload = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: target },
    });
    const r = runNode(guard, payload);
    assert(r.status === 0, `advisory gate must not block, exit=${r.status}`);
    const hookOutput = JSON.parse(r.stdout);
    const advisory = JSON.parse(hookOutput.hookSpecificOutput.additionalContext);
    assert(advisory.source === 'verification-quality' && advisory.status === 'warning' && advisory.blocking === false,
      `stale cross-project state was silently honored (no advisory emitted), stdout=${r.stdout.slice(0, 200)}`);
  });
});

test('verification gate does not treat make clean as functional verification', () => {
  const stateFile = path.join(HOME, 'var/verify-gate.json');
  const gate = path.join(HOME, 'engine/scripts/hooks/verification-gate.cjs');

  withFileBackup(stateFile, () => {
    fs.writeFileSync(stateFile, JSON.stringify({
      edited: true,
      verified: false,
      editCount: 1,
      lastEditTime: new Date().toISOString(),
    }, null, 2));

    const payload = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'make clean' },
    });
    const r = runNode(gate, payload);
    const state = readJson(stateFile, {});
    assert(r.status === 2, `make clean should be blocked while verification is pending, exit=${r.status}`);
    assert(state.edited === true && state.verified !== true, 'make clean cleared the pending verification state');
  });
});

test('verification gate only clears after successful PostToolUse evidence', () => {
  const stateFile = path.join(HOME, 'var/verify-gate.json');
  const ledgerFile = path.join(HOME, 'var/verification-ledger.json');
  const gate = path.join(HOME, 'engine/scripts/hooks/verification-gate.cjs');

  withFileBackup(stateFile, () => withFileBackup(ledgerFile, () => {
    fs.writeFileSync(stateFile, JSON.stringify({
      edited: true,
      verified: false,
      editCount: 1,
      lastEditTime: new Date().toISOString(),
    }, null, 2));

    const pre = runNode(gate, JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'pytest tests' },
    }));
    assert(pre.status === 0, `verification command should be allowed to run, exit=${pre.status}`);
    let state = readJson(stateFile, {});
    assert(state.edited === true && state.verified !== true, 'PreToolUse cleared verification before execution evidence existed');

    const postFail = runNode(gate, JSON.stringify({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'pytest tests' },
      tool_response: { status: 0, stdout: 'RESULT: FAIL', stderr: '' },
    }));
    assert(postFail.status === 0, `failed post evidence should not crash hook, exit=${postFail.status}`);
    state = readJson(stateFile, {});
    assert(state.edited === true && state.verified !== true, 'failed verification log cleared pending state');

    const postPass = runNode(gate, JSON.stringify({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'pytest tests' },
      tool_response: { status: 0, stdout: '2 passed', stderr: '' },
    }));
    assert(postPass.status === 0, `passing post evidence failed, exit=${postPass.status}`);
    state = readJson(stateFile, {});
    assert(state.edited === false && state.verified === true, 'passing PostToolUse evidence did not clear pending state');
  }));
});

test('verification gate allows read-only echo chains but blocks echo redirection', () => {
  const gate = path.join(HOME, 'engine/scripts/hooks/verification-gate.cjs');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-echo-'));
  const env = {
    CLAUDE_VERIFY_GATE_STATE_FILE: path.join(tmpRoot, 'verify-gate.json'),
    CLAUDE_VERIFICATION_LEDGER_FILE: path.join(tmpRoot, 'verification-ledger.json'),
  };
  const sessionId = 'echo-safety-session';

  runNode(gate, JSON.stringify({
    hook_event_name: 'PostToolUse',
    tool_name: 'Write',
    cwd: tmpRoot,
    session_id: sessionId,
    tool_input: { file_path: path.join(tmpRoot, 'dut.sv') },
  }), env);

  const readOnly = runNode(gate, JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    cwd: tmpRoot,
    session_id: sessionId,
    tool_input: { command: 'git log -1 && echo inspection-complete && ls' },
  }), env);
  assert(readOnly.status === 0, `read-only echo chain was blocked, exit=${readOnly.status}`);

  const redirected = runNode(gate, JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    cwd: tmpRoot,
    session_id: sessionId,
    tool_input: { command: 'echo payload > generated.sv' },
  }), env);
  assert(redirected.status === 2, `echo redirection escaped the gate, exit=${redirected.status}`);
});

test('verification pending is session-scoped and expires by TTL', () => {
  const gate = path.join(HOME, 'engine/scripts/hooks/verification-gate.cjs');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-session-'));
  const stateFile = path.join(tmpRoot, 'verify-gate.json');
  const env = {
    CLAUDE_VERIFY_GATE_STATE_FILE: stateFile,
    CLAUDE_VERIFICATION_LEDGER_FILE: path.join(tmpRoot, 'verification-ledger.json'),
    CLAUDE_VERIFY_GATE_TTL_MS: '60000',
  };

  runNode(gate, JSON.stringify({
    hook_event_name: 'PostToolUse',
    tool_name: 'Write',
    cwd: tmpRoot,
    session_id: 'session-a',
    tool_input: { file_path: path.join(tmpRoot, 'dut.sv') },
  }), env);

  const otherSession = runNode(gate, JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    cwd: tmpRoot,
    session_id: 'session-b',
    tool_input: { command: 'node build.cjs' },
  }), env);
  assert(otherSession.status === 0, `session-b inherited session-a pending state, exit=${otherSession.status}`);

  const sameSession = runNode(gate, JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    cwd: tmpRoot,
    session_id: 'session-a',
    tool_input: { command: 'node build.cjs' },
  }), env);
  assert(sameSession.status === 2, `unexpired pending state did not block its owner session, exit=${sameSession.status}`);

  const state = readJson(stateFile, {});
  const entry = Object.values(state.pending || {})[0];
  assert(entry, 'pending entry was not recorded');
  entry.lastEditTime = '2000-01-01T00:00:00.000Z';
  entry.expiresAt = '2000-01-01T00:01:00.000Z';
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');

  const expired = runNode(gate, JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    cwd: tmpRoot,
    session_id: 'session-a',
    tool_input: { command: 'node build.cjs' },
  }), env);
  assert(expired.status === 0, `expired pending state still blocked its owner session, exit=${expired.status}`);
});

test('verification gate cites the rule file without copying stale rule text', () => {
  const gate = fs.readFileSync(
    path.join(HOME, 'engine/scripts/hooks/verification-gate.cjs'),
    'utf8'
  );
  assert(gate.includes('docs/rules/00-core.md'), 'verification gate no longer cites docs/rules/00-core.md');
  assert(!gate.includes('rules/00-core.md 验证闭环铁律'), 'verification gate still labels stale text as an iron rule');
  assert(!gate.includes('改代码后必须跑对应的验证，不验证不提交'), 'verification gate still copies removed rule text');
});

test('context compression preserves constitution and dynamic rules', () => {
  const budget = require(path.join(HOME, 'engine/scripts/agent-context-budget.cjs'));
  const prompt = [
    '## Agent Constitution',
    'Hard rule: obey user constraints before efficiency.',
    '',
    '## Dynamic behaviour rules',
    'Ask for clarification when project requirements are ambiguous.',
    '',
    '## Memory Context (Auto-Loaded)',
    'x'.repeat(26000),
    '',
    '## AVAILABLE_SKILLS',
    'y'.repeat(6000),
  ].join('\n');

  const result = budget.compressPrompt(prompt, 'developer', { tier: 'normal' });
  assert(result.prompt.includes('## Agent Constitution'), 'constitution was removed during compression');
  assert(result.prompt.includes('## Dynamic behaviour rules'), 'dynamic behaviour rules were removed during compression');
});

test('workflow evidence gates are not based on agent self-report or catch-and-continue', () => {
  const workflowPath = path.join(HOME, 'workflows/hdl-coding-dag-workflow.js');
  const workflow = fs.readFileSync(workflowPath, 'utf8');

  assert(!workflow.includes('Does file exist:'), 'workflow still delegates file existence checks to agent self-report');
  assert(!workflow.includes('Read file:'), 'workflow still delegates file reads to agent self-report');
  assert(!workflow.includes('List .json files'), 'workflow still delegates directory listing to agent self-report');
  assert(!workflow.includes('06_doct'), 'workflow still contains the drifted 06_doct path');
  assert(
    !/catch\s*\(\s*e\s*\)\s*\{\s*results\s*\[\s*name\s*\]\s*=\s*\{\s*status:\s*'error'/s.test(workflow),
    'DAG executor still catches node errors and continues'
  );
});

function main() {
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  console.log('\nHarness painpoint regression tests\n');
  for (const t of tests) {
    process.stdout.write(`  ${t.name.padEnd(82)} `);
    try {
      t.fn();
      passed += 1;
      console.log('PASS');
    } catch (e) {
      if (e instanceof SkippedTest) {
        skipped += 1;
        console.log('SKIP');
        console.log(`    ${e.message}`);
        continue;
      }
      failed += 1;
      console.log('FAIL');
      console.log(`    ${e.message}`);
    }
  }

  console.log(`\nSummary: ${passed}/${tests.length} passed, ${failed} failed, ${skipped} skipped`);
  if (failed > 0) process.exit(1);
}

main();
