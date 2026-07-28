#!/usr/bin/env node
'use strict';

const { HARNESS_ROOT } = require('../lib/harness-root.cjs');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOME = HARNESS_ROOT;
const { validateWorkflowSet } = require(path.join(HOME, 'engine/scripts/lib/workflow-runtime.cjs'));
const {
  behaviorContractHash,
  commandEvidence,
  evidenceEntrySha256,
} = require(path.join(HOME, 'engine/scripts/lib/evidence-ledger.cjs'));

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertThrows(fn, pattern, message) {
  let thrown = null;
  try { fn(); }
  catch (error) { thrown = error; }
  assert(thrown && pattern.test(String(thrown.message || thrown)), message);
}

function read(relPath) {
  return fs.readFileSync(path.join(HOME, relPath), 'utf8');
}

function realBehaviorEvidence(fixture, label) {
  const evidenceDir = path.join(fixture, 'var', 'evidence');
  const scriptPath = path.join(evidenceDir, `${label}.cjs`);
  const ledgerPath = path.join(evidenceDir, `${label}.json`);
  fs.mkdirSync(evidenceDir, { recursive: true });
  const command = `${process.execPath} ${scriptPath}`;
  const capture = (source, accepted, startedAt, completedAt) => {
    fs.writeFileSync(scriptPath, source, 'utf8');
    const run = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });
    const entry = commandEvidence(command, {
      status: run.status,
      signal: run.signal,
      stdout: run.stdout,
      stderr: run.stderr,
    }, { startedAt, completedAt });
    entry.verification = {
      gate: 'verification-gate',
      accepted,
      reason: accepted ? 'real contract fixture passed' : 'real contract fixture failed',
    };
    entry.recordedAt = completedAt;
    return entry;
  };
  const red = capture(
    "process.stderr.write('RED: real payload rejected\\n'); process.exit(1);\n",
    false,
    '2026-07-28T02:01:00.000Z',
    '2026-07-28T02:01:01.000Z',
  );
  const green = capture(
    "process.stdout.write('PASS: real payload accepted\\n');\n",
    true,
    '2026-07-28T02:01:02.000Z',
    '2026-07-28T02:01:03.000Z',
  );
  fs.writeFileSync(ledgerPath, `${JSON.stringify({ schemaVersion: 1, entries: [red, green] }, null, 2)}\n`, 'utf8');
  return [{
    kind: 'behavioral_test',
    result: 'PASS',
    contractHash: behaviorContractHash(command),
    red: { status: 'RED', exitCode: 1, command, ledger: ledgerPath, entrySha256: evidenceEntrySha256(red) },
    green: { status: 'GREEN', exitCode: 0, command, ledger: ledgerPath, entrySha256: evidenceEntrySha256(green) },
  }];
}

test('all workflow files satisfy the strict runtime contract', () => {
  const result = validateWorkflowSet(path.join(HOME, 'workflows'));
  assert(result.ok, result.errors.join('\n'));
});

test('strict workflow contract rejects empty checkpoint and evidence arrays', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-contract-bad-'));
  const bad = path.join(tmp, 'code-review-workflow.js');
  fs.writeFileSync(bad, [
    'export const meta = {',
    "  name: 'code-review-workflow',",
    '  contract: {',
    '    version: 1,',
    '    strict: true,',
    '    inputs: ["target"],',
    '    checkpoints: [],',
    '    evidence: [],',
    '    completionCriteria: ["done"],',
    '  },',
    '};',
    "phase('noop');",
    'const workflowPassed = false;',
    'const blockingIssues = [];',
    'return { pass: workflowPassed, blockingIssues };',
    '',
  ].join('\n'), 'utf8');

  const result = validateWorkflowSet(tmp);
  assert(!result.ok, 'malformed strict workflow unexpectedly passed');
  assert(
    result.errors.some((error) => error.includes('contract.checkpoints')) &&
      result.errors.some((error) => error.includes('contract.evidence')),
    `missing structured contract errors: ${result.errors.join('|')}`
  );
});

test('workflow evidence scanner produces concrete file-line findings', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-evidence-'));
  const fixture = path.join(tmp, 'app.js');
  fs.writeFileSync(fixture, [
    'const api_key = "sk_test_123456789";',
    'eval(userInput);',
    'const query = "SELECT * FROM users WHERE id=" + id;',
  ].join('\n'), 'utf8');

  const script = path.join(HOME, 'engine/scripts/workflow-evidence-scan.cjs');
  const result = spawnSync('node', [script, '--json', '--targets', fixture], {
    cwd: tmp,
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  });
  assert(result.status === 0, `scanner exit=${result.status}\n${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert(parsed.filesScanned === 1, 'scanner did not scan the fixture file');
  assert(parsed.findings.hardcodedSecrets.length === 1, 'secret finding missing');
  assert(parsed.findings.dangerousCalls.length === 1, 'dangerous call finding missing');
  assert(parsed.findings.injectionRisks.length === 1, 'injection finding missing');
  const secret = parsed.findings.hardcodedSecrets[0];
  assert(secret.file && secret.line > 0, 'secret finding is missing file/line');
  assert(secret.ruleId === 'hardcoded-secret', 'secret finding is missing a stable rule id');
  assert(secret.key === 'api_key', `secret key was not classified: ${secret.key}`);
  assert(/^[a-f0-9]{64}$/.test(secret.valueHash || ''), 'secret value hash missing');
  assert(!JSON.stringify(parsed).includes('sk_test_123456789'), 'raw secret leaked into scanner output');
  for (const bucket of ['injectionRisks', 'dangerousCalls', 'configIssues']) {
    for (const finding of parsed.findings[bucket]) {
      assert(finding.file && finding.line > 0 && finding.evidence, 'finding is missing file/line/evidence');
    }
  }
});

test('workflow evidence scanner fails closed for missing, empty, escaped, and truncated scans', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-evidence-boundary-'));
  const script = path.join(HOME, 'engine/scripts/workflow-evidence-scan.cjs');
  const run = (argv) => {
    const result = spawnSync('node', [script, '--json', '--root', root, ...argv], {
      cwd: root,
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    });
    return { result, parsed: JSON.parse(result.stdout) };
  };

  const missing = run(['--targets-json', JSON.stringify(['missing.js'])]);
  assert(missing.result.status === 2, `missing target exit=${missing.result.status}`);
  assert(missing.parsed.status === 'invalid_target', `missing status=${missing.parsed.status}`);

  const emptyDir = path.join(root, 'empty');
  fs.mkdirSync(emptyDir);
  const empty = run(['--targets-json', JSON.stringify(['empty'])]);
  assert(empty.result.status === 2, `empty scan exit=${empty.result.status}`);
  assert(empty.parsed.status === 'empty_scan', `empty status=${empty.parsed.status}`);

  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-evidence-outside-'));
  fs.writeFileSync(path.join(outsideDir, 'outside.js'), 'const safe = true;\n', 'utf8');
  const escaped = run(['--targets-json', JSON.stringify([outsideDir])]);
  assert(escaped.result.status === 2, `escaped target exit=${escaped.result.status}`);
  assert(escaped.parsed.status === 'invalid_target', `escaped status=${escaped.parsed.status}`);

  const link = path.join(root, 'outside-link');
  let symlinkCreated = false;
  try {
    fs.symlinkSync(outsideDir, link, process.platform === 'win32' ? 'junction' : 'dir');
    symlinkCreated = true;
  } catch {
    // Direct root escape above still proves realpath containment where symlinks are unavailable.
  }
  if (symlinkCreated) {
    const linked = run(['--targets-json', JSON.stringify(['outside-link'])]);
    assert(linked.result.status === 2, `symlink escape exit=${linked.result.status}`);
    assert(linked.parsed.status === 'invalid_target', `symlink status=${linked.parsed.status}`);
    fs.rmSync(link, { recursive: true, force: true });
  }

  for (const name of ['c.js', 'a.js', 'b.js']) {
    fs.writeFileSync(path.join(root, name), `const ${name[0]} = true;\n`, 'utf8');
  }
  const truncated = run(['--targets-json', JSON.stringify(['.']), '--max-files', '2']);
  assert(truncated.result.status === 2, `truncated scan exit=${truncated.result.status}`);
  assert(truncated.parsed.status === 'truncated', `truncated status=${truncated.parsed.status}`);
  assert(truncated.parsed.truncated === true, 'truncated flag missing');
  assert(truncated.parsed.totalCandidates === 3, `candidate count=${truncated.parsed.totalCandidates}`);
  assert(JSON.stringify(truncated.parsed.scannedFiles) === JSON.stringify(['a.js', 'b.js']),
    `scan order is not deterministic: ${JSON.stringify(truncated.parsed.scannedFiles)}`);
  assert(/^[a-f0-9]{64}$/.test(truncated.parsed.manifestSha256 || ''), 'manifest hash missing');
});

test('code review workflow fails when blocking findings exist', () => {
  const content = read('workflows/code-review-workflow.js');
  assert(!/return\s*\{\s*pass\s*:\s*true\b/s.test(content), 'unconditional pass:true remains');
  assert(content.includes('workflowPassed'), 'workflowPassed gate missing');
  assert(content.includes('blockingIssues'), 'blockingIssues gate missing');
});

test('security workflow uses an argv request and binds complete scanner evidence', () => {
  const content = read('workflows/security-review-workflow.js');
  assert(content.includes("runner: 'argv'"), 'security workflow does not declare an argv runner');
  assert(content.includes("'--targets-json'"), 'security workflow does not pass targets as JSON argv');
  assert(!content.includes('`node engine/scripts/workflow-evidence-scan.cjs'),
    'security workflow still constructs an interpolated shell command');
  assert(!content.includes('"pattern": "匹配模式"'), 'workflow still asks for raw secret pattern evidence');
  for (const field of ['ruleId', 'key', 'valueHash']) {
    assert(content.includes(field), `workflow secret evidence schema is missing ${field}`);
  }
  for (const field of ['exitCode', 'status', 'truncated', 'manifestSha256', 'scanEvidenceValid']) {
    assert(content.includes(field), `security workflow does not bind ${field}`);
  }
});

test('RTL live eval uses isolated env, redaction, safe defaults, and finally cleanup', () => {
  const livePath = path.join(HOME, 'engine/scripts/test-hooks/rtl-live-task-eval.cjs');
  delete require.cache[require.resolve(livePath)];
  const live = require(livePath);
  for (const fn of ['buildIsolatedEnv', 'defaultCommandFor', 'redactSensitiveText', 'withCleanup']) {
    assert(typeof live[fn] === 'function', `rtl live eval does not export ${fn}`);
  }

  const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rtl-live-home-'));
  const isolated = live.buildIsolatedEnv(sandboxHome, {
    PATH: process.env.PATH || '',
    SystemRoot: process.env.SystemRoot || 'C:\\Windows',
    GITHUB_TOKEN: 'ghp_host_secret_should_not_escape',
    OPENAI_API_KEY: 'sk-host-secret-should-not-escape',
    AWS_SECRET_ACCESS_KEY: 'host-secret-should-not-escape',
  });
  assert(isolated.HOME === sandboxHome && isolated.USERPROFILE === sandboxHome,
    'live eval HOME/USERPROFILE are not isolated');
  assert(!('GITHUB_TOKEN' in isolated) && !('OPENAI_API_KEY' in isolated) && !('AWS_SECRET_ACCESS_KEY' in isolated),
    'host secret escaped the environment allowlist');

  const defaults = `${live.defaultCommandFor('claude')}\n${live.defaultCommandFor('codex')}`;
  assert(!/bypassPermissions|dangerously-bypass-approvals-and-sandbox/.test(defaults),
    `dangerous bypass remains in defaults: ${defaults}`);

  const redacted = live.redactSensitiveText('Authorization: Bearer abcdefghijklmnop token=topsecretvalue ghp_abcdefghijklmnopqrstuvwxyz123456');
  assert(!/abcdefghijklmnop|topsecretvalue|ghp_abcdefghijklmnopqrstuvwxyz123456/.test(redacted),
    `redactor leaked a secret: ${redacted}`);
  assert(redacted.includes('[REDACTED]'), 'redactor did not leave an explicit marker');
  const opaqueSecret = 'opaque-value-with-no-token-prefix';
  const explicitRedaction = live.redactSensitiveText(`agent emitted ${opaqueSecret}`, [opaqueSecret]);
  assert(!explicitRedaction.includes(opaqueSecret), 'explicit live-eval secret value leaked from output');

  let cleaned = false;
  let threw = false;
  try {
    live.withCleanup(() => { throw new Error('fixture failure'); }, () => { cleaned = true; });
  } catch {
    threw = true;
  }
  assert(threw && cleaned, 'cleanup did not run when the operation threw');
});

test('RTL live eval fails closed before launching an agent without network opt-in', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rtl-live-network-'));
  const outDir = path.join(tmp, 'out');
  const marker = path.join(tmp, 'agent-ran.txt');
  const fakeAgent = path.join(tmp, 'fake-agent.cjs');
  fs.writeFileSync(fakeAgent, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n`, 'utf8');
  const livePath = path.join(HOME, 'engine/scripts/test-hooks/rtl-live-task-eval.cjs');
  const command = `"${process.execPath}" "${fakeAgent}"`;
  const result = spawnSync(process.execPath, [livePath, '--agent', 'claude', '--command', command, '--out', outDir], {
    cwd: HOME,
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
    env: { ...process.env, CLAUDE_READINESS_COMMAND: `"${process.execPath}" --version` },
  });
  assert(result.status === 2, `network-denied live eval exit=${result.status}\n${result.stderr || result.stdout}`);
  assert(!fs.existsSync(marker), 'agent launched before explicit network authorization');
  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'rtl-live-task-eval.json'), 'utf8'));
  assert(manifest.status === 'blocked' && manifest.networkPolicy?.authorized === false,
    `network policy did not fail closed: ${JSON.stringify(manifest.networkPolicy)}`);
  assert(manifest.manifestRevision >= 1 && manifest.progress?.some((item) => item.stage === 'network-policy'),
    'blocked run did not write incremental manifest evidence');
});

test('root shell scripts are thin compatibility wrappers for canonical engine scripts', () => {
  const rootModule = read('scripts/init-module.sh');
  const rootProject = read('scripts/init-project.sh');
  const engineModule = read('engine/scripts/init-module.sh');
  const engineProject = read('engine/scripts/init-project.sh');
  assert(rootModule.includes('exec "$ROOT_DIR/engine/scripts/init-module.sh" "$@"'), 'root init-module bypasses canonical engine shell script');
  assert(rootProject.includes('exec "$ROOT_DIR/engine/scripts/init-project.sh" "$@"'), 'root init-project bypasses canonical engine shell script');
  assert(!rootModule.includes('init-module.cjs'), 'root init-module contains implementation target details');
  assert(!rootProject.includes('harness-init.cjs'), 'root init-project duplicates implementation target details');
  assert(engineModule.includes('init-module.cjs'), 'canonical engine init-module implementation target missing');
  assert(engineProject.includes('harness-init.cjs'), 'canonical engine init-project implementation target missing');
});

test('root and platform workflow directories do not drift', () => {
  const rootDir = path.join(HOME, 'workflows');
  const platformDir = path.join(HOME, '.claude', 'workflows');
  const jsNames = (dir) => fs.readdirSync(dir).filter((name) => name.endsWith('.js')).sort();
  const rootNames = jsNames(rootDir);
  const platformNames = jsNames(platformDir);
  assert(JSON.stringify(rootNames) === JSON.stringify(platformNames),
    `workflow file sets differ: root=${rootNames.join(',')} platform=${platformNames.join(',')}`);
  for (const name of rootNames) {
    const rootBytes = fs.readFileSync(path.join(rootDir, name));
    const platformBytes = fs.readFileSync(path.join(platformDir, name));
    assert(rootBytes.equals(platformBytes), `workflow drift detected: ${name}`);
  }
});

test('HDL workflow never accepts arbitrary output merely containing PASS', () => {
  const content = read('workflows/hdl-coding-dag-workflow.js');
  assert(
    !/\.includes\(\s*['"]PASS['"]\s*\)/.test(content),
    'substring PASS acceptance remains in the HDL workflow'
  );
  // v3.6: 结构化证据判定移入确定性脚本 hdl-evidence-gate.cjs;
  // 工作流侧只接受 gate_executed/gate_ok + compared_points 的结构化返回。
  // 测试意图不变: 证据判定必须是结构化的, 不允许子串 PASS 匹配。
  assert(content.includes('hdl-evidence-gate.cjs'), 'deterministic evidence gate script reference missing');
  assert(/gate_executed\s*===\s*true/.test(content), 'structured gate_executed check missing');
  assert(/gate_ok\s*===\s*true/.test(content), 'structured gate_ok check missing');
  assert(/\(\s*\w+\?*\.?compared_points\s*\|\|\s*0\s*\)\s*>\s*0/.test(content), 'structured module evidence count gate missing');
  const gateScript = read('engine/scripts/hdl-evidence-gate.cjs');
  assert(gateScript.includes("data.status !== 'PASS'"), 'gate script structural status check missing');
  assert(gateScript.includes('points > 0'), 'gate script structural count check missing');

  const helperStart = content.indexOf('function _parseStrictJsonObject(raw)');
  const helperEnd = content.indexOf('function _checkpointConfirmed', helperStart);
  assert(helperStart >= 0 && helperEnd > helperStart, 'strict JSON parser helper missing');
  const parseStrictJsonObject = Function(
    `${content.slice(helperStart, helperEnd)}; return _parseStrictJsonObject;`
  )();
  assert(parseStrictJsonObject('simulation did NOT PASS') === null, 'arbitrary PASS text was parsed');
  assert(parseStrictJsonObject('prefix {"pass":true,"evidence_ok":true}') === null, 'embedded JSON was parsed');
  const verdict = parseStrictJsonObject('{"pass":true,"evidence_ok":true}');
  assert(verdict?.pass === true && verdict?.evidence_ok === true, 'complete structured verdict was rejected');
});

test('workflow trigger docs match actual workflow behavior', () => {
  const docs = read('docs/rules-archive/05-workflow-trigger.md');
  assert(!docs.includes('Writer→Reviewer→Arbiter'), 'stale code-review route description remains');
  assert(docs.includes('Pass 1 正确性'), 'code-review route does not mention actual Pass 1 flow');
  assert(docs.includes('workflow-evidence-scan.cjs'), 'security route does not mention deterministic evidence scan');
});

test('memory health fails closed when the learning loop is structurally green but functionally broken', () => {
  const healthPath = path.join(HOME, 'engine/scripts/memory-health-check.cjs');
  delete require.cache[require.resolve(healthPath)];
  const health = require(healthPath);
  assert(typeof health.buildHealthReport === 'function', 'memory health report API missing');

  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-health-contract-'));
  const memoryDir = path.join(fixture, 'memory');
  const learningDir = path.join(memoryDir, 'learnings');
  const errorDir = path.join(memoryDir, 'errors');
  const indexDir = path.join(fixture, 'var', 'index');
  const maintenanceDir = path.join(fixture, 'var', 'maintenance');
  fs.mkdirSync(learningDir, { recursive: true });
  fs.mkdirSync(errorDir, { recursive: true });
  fs.mkdirSync(indexDir, { recursive: true });
  fs.mkdirSync(maintenanceDir, { recursive: true });
  fs.mkdirSync(path.join(fixture, '.claude'), { recursive: true });

  const currentLearning = '# Verified learning\nBehavioral evidence exists.\n';
  fs.writeFileSync(path.join(learningDir, 'verified.md'), currentLearning, 'utf8');
  fs.writeFileSync(path.join(learningDir, 'missing-from-sqlite.md'), '# Current only\n', 'utf8');
  fs.writeFileSync(path.join(errorDir, '2026-07-28-hook_failure_stub.md'), '# Failure\n待分析\n待补充\n', 'utf8');
  fs.writeFileSync(path.join(fixture, '.claude', 'scheduled_tasks.json'), '{"tasks":[]}', 'utf8');
  fs.writeFileSync(path.join(maintenanceDir, 'memory-knowledge-maintenance.json'), JSON.stringify({
    lastExecutedAt: '2026-07-01T00:00:00.000Z',
  }), 'utf8');
  fs.writeFileSync(path.join(indexDir, 'semantic-index-meta.json'), JSON.stringify({
    builtAt: '2026-07-01T00:00:00.000Z',
    fileCount: 1,
    files: [],
  }), 'utf8');

  const { openDb } = require(path.join(HOME, 'engine/sqlite/index.cjs'));
  const { writeMemory } = require(path.join(HOME, 'engine/sqlite/store-memory.cjs'));
  const events = require(path.join(HOME, 'engine/sqlite/store-events.cjs'));
  const wDb = openDb({ path: ':memory:' });
  writeMemory({
    namespace: 'learnings',
    name: 'verified',
    content: currentLearning,
    source: 'migration:file',
    confidence: 0.9,
  }, { db: wDb.db });
  for (let index = 0; index < 8; index += 1) {
    events.record({ sessionId: `synthetic-${index}`, type: 'rule_load', payload: {} }, null, { db: wDb.db });
  }
  events.setWatermark(6, { db: wDb.db, consumer: 'dream' });

  const report = health.buildHealthReport({
    db: wDb.db,
    home: fixture,
    now: Date.parse('2026-07-28T00:00:00.000Z'),
    consumerSchedules: { dream: true, 'skill-evolve': false },
  });
  wDb.close();

  assert(report.status === 'unhealthy' && report.score < 70,
    `broken learning loop false-greened: ${JSON.stringify(report)}`);
  assert(report.metrics.events.pending === 8 && report.metrics.events.safeWatermark === 0,
    'slowest-consumer pending/watermark evidence missing');
  const dreamConsumer = report.metrics.events.consumers.find((item) => item.consumer === 'dream');
  const skillConsumer = report.metrics.events.consumers.find((item) => item.consumer === 'skill-evolve');
  assert(dreamConsumer?.watermark === 6 && dreamConsumer.pending === 2 && dreamConsumer.scheduled === true,
    `Dream consumer evidence missing: ${JSON.stringify(report.metrics.events.consumers)}`);
  assert(skillConsumer?.watermark === 0 && skillConsumer.pending === 8 && skillConsumer.scheduled === false,
    `Skill-Evolve consumer evidence missing: ${JSON.stringify(report.metrics.events.consumers)}`);
  assert(report.metrics.events.dreamOutputs === 0, 'missing Dream-output evidence');
  assert(report.metrics.sessions.singletonRatio === 1, 'session identity quality missing');
  assert(report.metrics.consistency.missingInSqlite > 0, 'Markdown/SQLite drift missing');
  assert(report.metrics.markdown.noiseFiles > 0, 'memory noise evidence missing');
  assert(report.metrics.semantic.stale === true, 'semantic freshness evidence missing');
  assert(report.metrics.maintenance.due === true && report.metrics.maintenance.scheduleConfigured === false,
    'maintenance due/schedule evidence missing');
  for (const code of [
    'pending_event_backlog',
    'event_consumer_unscheduled',
    'dream_output_missing',
    'session_identity_degraded',
    'markdown_sqlite_drift',
    'memory_noise',
    'semantic_index_stale',
    'maintenance_overdue',
    'maintenance_schedule_missing',
  ]) {
    assert(report.issues.some((issue) => issue.code === code), `health issue missing: ${code}`);
  }
});

test('memory health excludes retired facts without hiding a genuinely missing active file', () => {
  const healthPath = path.join(HOME, 'engine/scripts/memory-health-check.cjs');
  delete require.cache[require.resolve(healthPath)];
  const health = require(healthPath);
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-health-status-contract-'));
  const learningDir = path.join(fixture, 'memory', 'learnings');
  const errorDir = path.join(fixture, 'memory', 'errors');
  fs.mkdirSync(learningDir, { recursive: true });
  fs.mkdirSync(errorDir, { recursive: true });

  const presentPath = path.join(learningDir, 'present.md');
  const missingPath = path.join(learningDir, 'genuinely-missing.md');
  const retiredPath = path.join(learningDir, 'retired.md');
  const presentContent = '# Present\nValidated current learning.\n';
  const retiredContent = '---\nstatus: superseded\n---\n# Retired\nOld learning.\n';
  fs.writeFileSync(presentPath, presentContent, 'utf8');
  fs.writeFileSync(missingPath, '# Missing\nThis active file has no SQLite fact.\n', 'utf8');
  fs.writeFileSync(retiredPath, retiredContent, 'utf8');
  fs.writeFileSync(path.join(errorDir, 'ERROR_TEMPLATE.md'), '# Error template\nplaceholder\n', 'utf8');

  const { openDb } = require(path.join(HOME, 'engine/sqlite/index.cjs'));
  const { writeMemory, softDeleteMemory } = require(path.join(HOME, 'engine/sqlite/store-memory.cjs'));
  const wDb = openDb({ path: ':memory:' });
  writeMemory({
    namespace: 'learnings',
    name: 'present',
    content: presentContent,
    source: 'migration:file',
    sourceKey: 'learnings/present.md',
    sourcePath: presentPath,
    confidence: 0.9,
  }, { db: wDb.db });
  const retired = writeMemory({
    namespace: 'learnings',
    name: 'retired',
    content: retiredContent,
    source: 'migration:file',
    sourceKey: 'learnings/retired.md',
    sourcePath: retiredPath,
    confidence: 0.7,
  }, { db: wDb.db });
  softDeleteMemory(retired.id, { db: wDb.db });
  const dream = writeMemory({
    namespace: 'learnings',
    name: 'retired-dream',
    content: '# Dream\nstatus: review_required\n',
    source: 'script:dream',
    confidence: 0.4,
  }, { db: wDb.db });
  softDeleteMemory(dream.id, { db: wDb.db });

  const report = health.buildHealthReport({
    db: wDb.db,
    home: fixture,
    now: Date.parse('2026-07-28T06:00:00.000Z'),
    consumerSchedules: { dream: true, 'skill-evolve': true },
  });
  wDb.close();

  assert(report.metrics.facts.total === 3 && report.metrics.facts.active === 1
    && report.metrics.facts.tombstone === 2,
  `fact lifecycle counts are wrong: ${JSON.stringify(report.metrics.facts)}`);
  assert(report.metrics.facts.expiredActive === 0 && report.metrics.facts.expiredRetired === 2,
    `retired TTLs polluted active expiry: ${JSON.stringify(report.metrics.facts)}`);
  assert(report.metrics.markdown.eligibleFacts === 2,
    `template/superseded files entered active memory: ${JSON.stringify(report.metrics.markdown)}`);
  assert(report.metrics.consistency.matched === 1
    && report.metrics.consistency.missingInSqlite === 1
    && report.metrics.consistency.staleInSqlite === 0
    && report.metrics.consistency.retiredFileFacts === 1,
  `active/retired consistency is wrong: ${JSON.stringify(report.metrics.consistency)}`);
  assert(!report.issues.some((issue) => issue.code === 'expired_facts_pending'),
    'retired tombstones were reported as pending active expiry');
  assert(report.issues.some((issue) => issue.code === 'markdown_sqlite_drift'
    && issue.evidence.missingInSqlite === 1),
  'genuine active Markdown/SQLite drift was hidden');
});

test('memory health detects content drift through stable file identity', () => {
  const healthPath = path.join(HOME, 'engine/scripts/memory-health-check.cjs');
  delete require.cache[require.resolve(healthPath)];
  const health = require(healthPath);
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-health-content-contract-'));
  const learningDir = path.join(fixture, 'memory', 'learnings');
  fs.mkdirSync(learningDir, { recursive: true });

  const learningPath = path.join(learningDir, 'stable-learning.md');
  fs.writeFileSync(learningPath, '# Stable learning\nCurrent file content.\n', 'utf8');

  const { openDb } = require(path.join(HOME, 'engine/sqlite/index.cjs'));
  const { writeMemory } = require(path.join(HOME, 'engine/sqlite/store-memory.cjs'));
  const wDb = openDb({ path: ':memory:' });
  writeMemory({
    namespace: 'learnings',
    name: 'stable-learning',
    content: '# Stable learning\nObsolete SQLite content.\n',
    source: 'migration:file',
    sourceKey: 'learnings/stable-learning.md',
    sourcePath: learningPath,
    confidence: 0.9,
  }, { db: wDb.db });

  const report = health.buildHealthReport({
    db: wDb.db,
    home: fixture,
    now: Date.parse('2026-07-28T06:00:00.000Z'),
    consumerSchedules: { dream: true, 'skill-evolve': true },
  });
  wDb.close();

  assert(report.metrics.consistency.matched === 0
    && report.metrics.consistency.missingInSqlite === 0
    && report.metrics.consistency.staleInSqlite === 0
    && report.metrics.consistency.contentMismatch === 1,
  `stable identity did not expose content drift: ${JSON.stringify(report.metrics.consistency)}`);
  assert(report.issues.some((issue) => issue.code === 'markdown_sqlite_drift'
    && issue.evidence.contentMismatch === 1),
  'content mismatch did not fail Markdown/SQLite consistency');
});

test('memory freshness governance exempts reconciled files but flags unmanaged permanent facts', () => {
  const healthPath = path.join(HOME, 'engine/scripts/memory-health-check.cjs');
  delete require.cache[require.resolve(healthPath)];
  const health = require(healthPath);
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-health-freshness-contract-'));
  const learningDir = path.join(fixture, 'memory', 'learnings');
  fs.mkdirSync(learningDir, { recursive: true });

  const governedPath = path.join(learningDir, 'governed.md');
  const governedContent = '# Governed learning\nReconciled from its durable source.\n';
  fs.writeFileSync(governedPath, governedContent, 'utf8');

  const { openDb } = require(path.join(HOME, 'engine/sqlite/index.cjs'));
  const { writeMemory } = require(path.join(HOME, 'engine/sqlite/store-memory.cjs'));
  const wDb = openDb({ path: ':memory:' });
  writeMemory({
    namespace: 'learnings',
    name: 'governed',
    content: governedContent,
    source: 'migration:file',
    sourceKey: 'learnings/governed.md',
    sourcePath: governedPath,
    confidence: 0.9,
  }, { db: wDb.db });

  const governed = health.buildHealthReport({
    db: wDb.db,
    home: fixture,
    now: Date.parse('2026-07-28T06:00:00.000Z'),
    consumerSchedules: { dream: true, 'skill-evolve': true },
  });
  assert(governed.metrics.facts.sourceReconciledPermanent === 1
    && governed.metrics.facts.unmanagedPermanent === 0,
  `source-governed permanence was misclassified: ${JSON.stringify(governed.metrics.facts)}`);
  assert(!governed.issues.some((issue) => issue.code === 'freshness_governance_missing'
    || issue.code === 'ttl_policy_inactive'),
  `reconciled file fact was incorrectly required to expire: ${JSON.stringify(governed.issues)}`);

  writeMemory({
    namespace: 'learnings',
    name: 'unmanaged',
    content: '# Unmanaged learning\nNo TTL or durable source reconciliation.\n',
    source: 'manual',
    confidence: 0.7,
  }, { db: wDb.db });
  const unmanaged = health.buildHealthReport({
    db: wDb.db,
    home: fixture,
    now: Date.parse('2026-07-28T06:00:00.000Z'),
    consumerSchedules: { dream: true, 'skill-evolve': true },
  });
  wDb.close();

  assert(unmanaged.metrics.facts.sourceReconciledPermanent === 1
    && unmanaged.metrics.facts.unmanagedPermanent === 1,
  `unmanaged permanence was not isolated: ${JSON.stringify(unmanaged.metrics.facts)}`);
  assert(unmanaged.issues.some((issue) => issue.code === 'freshness_governance_missing'
    && issue.evidence.unmanagedPermanent === 1),
  `unmanaged permanent fact did not fail freshness governance: ${JSON.stringify(unmanaged.issues)}`);
});

test('memory health recognizes only an enabled executing SessionStart maintenance hook', () => {
  const healthPath = path.join(HOME, 'engine/scripts/memory-health-check.cjs');
  delete require.cache[require.resolve(healthPath)];
  const health = require(healthPath);
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-health-schedule-contract-'));
  fs.mkdirSync(path.join(fixture, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(fixture, '.claude', 'scheduled_tasks.json'), '{"tasks":[]}', 'utf8');
  const settingsPath = path.join(fixture, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({
    hooks: {
      SessionStart: [{
        matcher: 'startup',
        hooks: [{
          type: 'command',
          command: 'node C:/harness/engine/scripts/memory-knowledge-maintenance.cjs --auto --execute',
          timeout: 120,
          async: true,
        }],
      }],
    },
  }), 'utf8');

  const scheduled = health.inspectMaintenance(fixture, Date.parse('2026-07-28T06:00:00.000Z'));
  assert(scheduled.scheduleConfigured === true
    && scheduled.scheduleSources.includes('settings.json:SessionStart'),
  `live SessionStart maintenance was not recognized: ${JSON.stringify(scheduled)}`);

  fs.writeFileSync(settingsPath, JSON.stringify({
    hooks: {
      SessionStart: [{
        matcher: 'startup',
        hooks: [
          {
            type: 'command',
            command: 'node C:/harness/engine/scripts/memory-knowledge-maintenance.cjs --auto --dry-run',
          },
          {
            type: 'command',
            command: 'node C:/harness/engine/scripts/memory-knowledge-maintenance.cjs --auto --execute',
            enabled: false,
          },
        ],
      }],
    },
  }), 'utf8');
  const inactive = health.inspectMaintenance(fixture, Date.parse('2026-07-28T06:00:00.000Z'));
  assert(inactive.scheduleConfigured === false,
    `dry-run/disabled maintenance false-greened: ${JSON.stringify(inactive)}`);

  fs.writeFileSync(settingsPath, '{"hooks":{}}', 'utf8');
  const scheduledTasksPath = path.join(fixture, '.claude', 'scheduled_tasks.json');
  fs.writeFileSync(scheduledTasksPath, JSON.stringify({
    tasks: [{
      enabled: true,
      command: 'node C:/harness/engine/scripts/memory-knowledge-maintenance.cjs --auto --execute',
    }],
  }), 'utf8');
  const periodic = health.inspectMaintenance(fixture, Date.parse('2026-07-28T06:00:00.000Z'));
  assert(periodic.scheduleConfigured === true
    && periodic.scheduleSources.includes('.claude/scheduled_tasks.json'),
  `executing periodic maintenance was not recognized: ${JSON.stringify(periodic)}`);

  fs.writeFileSync(scheduledTasksPath, JSON.stringify({
    tasks: [{
      enabled: true,
      command: 'node C:/harness/engine/scripts/memory-knowledge-maintenance.cjs --auto --execute --dry-run',
    }],
  }), 'utf8');
  const periodicDryRun = health.inspectMaintenance(fixture, Date.parse('2026-07-28T06:00:00.000Z'));
  assert(periodicDryRun.scheduleConfigured === false,
    `periodic dry-run false-greened: ${JSON.stringify(periodicDryRun)}`);
});

test('memory maintenance keeps dry-run read-only and executes only bounded maintenance interfaces', () => {
  const maintenancePath = path.join(HOME, 'engine/scripts/memory-knowledge-maintenance.cjs');
  delete require.cache[require.resolve(maintenancePath)];
  const maintenance = require(maintenancePath);
  assert(typeof maintenance.runMaintenance === 'function', 'bounded maintenance API missing');

  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-maintenance-contract-'));
  const memoryDir = path.join(fixture, 'memory');
  const errorsDir = path.join(memoryDir, 'errors');
  const workDir = path.join(memoryDir, 'work');
  const stateDir = path.join(fixture, 'var', 'maintenance');
  fs.mkdirSync(errorsDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(errorsDir, '2026-06-01-repeat-failure.md'), [
    '# Repeated failure',
    '## Root cause',
    'A status-less hook payload was treated as success.',
    '## Verified fix',
    'A real-shape regression now fails before the parser repair and passes after it.',
    '## Prevention',
    'Require explicit PASS/FAIL evidence for every real payload shape.',
    '## Trigger conditions',
    '- PostToolUse payload has no status field.',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(workDir, '2026-06-01-tool_success_fixture.md'), '# Tool success\n', 'utf8');
  fs.writeFileSync(path.join(stateDir, 'memory-knowledge-maintenance.json'), JSON.stringify({
    lastExecutedAt: '2026-07-01T00:00:00.000Z',
  }), 'utf8');

  const calls = [];
  const runtime = {
    home: fixture,
    inspectSqlite: () => ({ totalFacts: 1, expiredFacts: 0, consumedEventsPastRetention: 4 }),
    retainEvents: (plan) => { calls.push(['retain', plan]); return { deleted: 4 }; },
    reconcileFacts: (plan) => { calls.push(['reconcile', plan]); return { inserted: 1, removed: 1 }; },
    stageCandidates: (candidates) => { calls.push(['candidates', candidates]); return { staged: candidates.length }; },
    rebuildIndex: () => { calls.push(['reindex']); return { status: 0 }; },
    saveState: (state) => { calls.push(['state', state]); },
  };
  const now = new Date('2026-07-28T00:00:00.000Z');
  const common = {
    ...maintenance.parseArgs(['--force', '--error-days', '1', '--event-retention-days', '14', '--reconcile']),
    reindex: true,
  };

  const dryRun = maintenance.runMaintenance({ ...common, execute: false, dryRun: true }, now, runtime);
  assert(calls.length === 0, `dry-run performed writes: ${JSON.stringify(calls)}`);
  assert(dryRun.mode === 'dry-run' && dryRun.due === true, 'dry-run due state missing');
  assert(dryRun.plan.eventRetentionDays === 14 && dryRun.plan.reconcile === true && dryRun.plan.reindex === true,
    `dry-run plan is incomplete: ${JSON.stringify(dryRun.plan)}`);
  assert(dryRun.plan.ruleCandidates.length === 1, 'verified error was not proposed as a rule candidate');
  assert(dryRun.plan.fileActions.every((item) => item.action !== 'move'), 'maintenance still plans raw archive moves');

  const executed = maintenance.runMaintenance({ ...common, execute: true, dryRun: false }, now, runtime);
  assert(executed.mode === 'execute' && executed.results.events.deleted === 4, 'event retention interface not executed');
  assert(executed.results.reconcile.inserted === 1, 'fact reconciliation interface not executed');
  assert(executed.results.candidates.staged === 1, 'candidate staging interface not executed');
  assert(executed.results.reindex.status === 0, 'semantic reindex interface not executed');
  assert(JSON.stringify(calls.map((item) => item[0])) === JSON.stringify(['retain', 'reconcile', 'candidates', 'reindex', 'state']),
    `unexpected maintenance side effects: ${JSON.stringify(calls)}`);
});

test('memory retention waits for every registered consumer and uses the consumer purge API', () => {
  const maintenancePath = path.join(HOME, 'engine/scripts/memory-knowledge-maintenance.cjs');
  delete require.cache[require.resolve(maintenancePath)];
  const maintenance = require(maintenancePath);
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-retention-contract-'));
  const dbPath = path.join(fixture, 'memory.db');
  const { openDb } = require(path.join(HOME, 'engine/sqlite/index.cjs'));
  const events = require(path.join(HOME, 'engine/sqlite/store-events.cjs'));
  let wDb = openDb({ path: dbPath });
  const ids = [];
  for (let index = 0; index < 3; index += 1) {
    ids.push(events.record({
      sessionId: 'retention-contract',
      type: 'tool_fail',
      payload: { index },
    }, '2025-01-01T00:00:00.000Z', { db: wDb.db }));
  }
  events.setWatermark(ids[2], { db: wDb.db, consumer: 'dream' });
  wDb.close();

  const opts = maintenance.parseArgs([
    '--force', '--execute', '--event-retention-days', '14', '--no-reconcile', '--no-reindex',
    '--home', fixture, '--db-path', dbPath,
  ]);
  const runtime = { home: fixture, saveState: () => {} };
  const blocked = maintenance.runMaintenance(opts, new Date('2026-07-28T00:00:00.000Z'), runtime);
  assert(blocked.results.events.deleted === 0 && blocked.results.events.safeWatermark === 0
    && blocked.results.events.consumers === 2,
  `retention bypassed a lagging consumer: ${JSON.stringify(blocked.results.events)}`);

  wDb = openDb({ path: dbPath });
  events.setWatermark(ids[2], { db: wDb.db, consumer: 'skill-evolve' });
  wDb.close();
  const purged = maintenance.runMaintenance(opts, new Date('2026-07-28T00:00:00.000Z'), runtime);
  assert(purged.results.events.deleted === 3 && purged.results.events.safeWatermark === ids[2]
    && purged.results.events.consumers === 2,
  `consumer purge API was not used: ${JSON.stringify(purged.results.events)}`);

  wDb = openDb({ path: dbPath, readonly: true });
  const remaining = Number(wDb.db.prepare('SELECT COUNT(*) AS count FROM runtime_events').get().count || 0);
  const dreamWatermark = events.getWatermark({ db: wDb.db, consumer: 'dream' });
  const skillWatermark = events.getWatermark({ db: wDb.db, consumer: 'skill-evolve' });
  wDb.close();
  assert(remaining === 0 && dreamWatermark === ids[2] && skillWatermark === ids[2],
    `retention changed consumer progress or left expired events: remaining=${remaining} dream=${dreamWatermark} skill=${skillWatermark}`);
});

test('memory fact reconciliation uses stable source identity and tombstones legacy orphans', () => {
  const maintenancePath = path.join(HOME, 'engine/scripts/memory-knowledge-maintenance.cjs');
  delete require.cache[require.resolve(maintenancePath)];
  const maintenance = require(maintenancePath);
  assert(typeof maintenance.fileFacts === 'function', 'stable file fact adapter is missing');

  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-reconcile-contract-'));
  const errorsDir = path.join(fixture, 'memory', 'errors');
  const workDir = path.join(fixture, 'memory', 'work');
  fs.mkdirSync(errorsDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  const verifiedContent = [
    '---',
    'verified: true',
    'project_id: project-a',
    'scope_kind: repository',
    'trigger_kind: tool_failure',
    'trigger_signature: statusless_payload',
    'evidence_ref: test:real-payload-regression',
    'valid_until: 2026-12-31T00:00:00.000Z',
    '---',
    '# Verified hook failure',
    '## Root cause',
    'A status-less payload was accepted.',
    '## Verified fix',
    'A real-shape RED then GREEN regression.',
    '## Prevention',
    'Require explicit outcome evidence.',
    '## Trigger conditions',
    '- PostToolUse payload lacks status.',
  ].join('\n');
  const verifiedPath = path.join(errorsDir, 'verified.md');
  fs.writeFileSync(verifiedPath, verifiedContent, 'utf8');
  fs.writeFileSync(path.join(errorsDir, 'unverified.md'), '# Unverified\nOnly a symptom is known.\n', 'utf8');
  fs.writeFileSync(path.join(workDir, '2026-07-28-tool_success_noise.md'), '# tool_success\n', 'utf8');

  const adapted = maintenance.fileFacts(fixture);
  const verifiedFact = adapted.find((item) => item.sourceKey === 'errors/verified.md');
  const unverifiedFact = adapted.find((item) => item.sourceKey === 'errors/unverified.md');
  assert(adapted.length === 2, `noise or index files entered reconciliation: ${JSON.stringify(adapted)}`);
  assert(verifiedFact?.sourcePath === path.resolve(verifiedPath) && verifiedFact.confidence === 0.9,
    `verified error identity/confidence is wrong: ${JSON.stringify(verifiedFact)}`);
  assert(verifiedFact?.projectId === 'project-a' && verifiedFact.scopeKind === 'repository'
      && verifiedFact.triggerKind === 'tool_failure'
      && verifiedFact.triggerSignature === 'statusless_payload'
      && verifiedFact.verificationState === 'verified'
      && verifiedFact.evidenceRef === 'test:real-payload-regression'
      && Number.isFinite(verifiedFact.validUntil),
    `reconciliation dropped applicability metadata: ${JSON.stringify(verifiedFact)}`);
  assert(unverifiedFact?.confidence === 0.4, `unverified error was over-trusted: ${JSON.stringify(unverifiedFact)}`);

  const dbPath = path.join(fixture, 'memory.db');
  const { openDb } = require(path.join(HOME, 'engine/sqlite/index.cjs'));
  const { writeMemory } = require(path.join(HOME, 'engine/sqlite/store-memory.cjs'));
  let wDb = openDb({ path: dbPath });
  const claimed = writeMemory({
    namespace: 'errors',
    name: 'legacy-current',
    content: verifiedContent,
    source: 'migration:file',
    confidence: 0.9,
  }, { db: wDb.db });
  const orphan = writeMemory({
    namespace: 'errors',
    name: 'legacy-deleted-noise',
    content: '# Deleted legacy noise\nold generated record',
    source: 'migration:file',
    confidence: 0.9,
  }, { db: wDb.db });
  const dream = writeMemory({
    namespace: 'learnings',
    name: 'dream-candidate',
    content: '# Dream candidate\nstatus: review_required',
    source: 'script:dream',
    confidence: 0.4,
  }, { db: wDb.db });
  wDb.close();

  const result = maintenance.defaultReconcileFacts({}, { home: fixture, dbPath });
  assert(result.retiredLegacy === 1 && result.tombstoned >= 0,
    `legacy retirement evidence missing: ${JSON.stringify(result)}`);
  wDb = openDb({ path: dbPath, readonly: true });
  const rows = wDb.db.prepare(
    'SELECT id, source, source_key, source_path, confidence, status FROM facts ORDER BY id',
  ).all();
  wDb.close();
  const claimedRow = rows.find((item) => item.id === claimed.id);
  const orphanRow = rows.find((item) => item.id === orphan.id);
  const dreamRow = rows.find((item) => item.id === dream.id);
  assert(claimedRow?.source_key === 'errors/verified.md'
    && claimedRow.source_path === path.resolve(verifiedPath)
    && claimedRow.status === 'active',
  `same-content legacy row was not claimed: ${JSON.stringify(claimedRow)}`);
  assert(orphanRow?.status === 'tombstone', `legacy orphan was hard-deleted or left active: ${JSON.stringify(orphanRow)}`);
  assert(dreamRow?.status === 'active' && dreamRow.source === 'script:dream',
    `non-file Dream fact was changed: ${JSON.stringify(dreamRow)}`);
  assert(rows.filter((item) => item.source_key === 'errors/verified.md').length === 1,
    'same source was duplicated during reconciliation');
});

test('kb frontmatter coverage excludes generated indexes but keeps safety controls and references', () => {
  const kb = require(path.join(HOME, 'engine/scripts/kb-stats.cjs'));
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-frontmatter-contract-'));
  const knowledge = path.join(fixture, 'engineering-assets', 'knowledge');
  const write = (relative, content) => {
    const file = path.join(knowledge, ...relative.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
  };
  write('INDEX.md', '---\nname: index\n---\n# Index\n');
  write('INDEX-FILES.md', '# Generated files index\n');
  write('primary/domain/_SUPERSEDED.md', '# Safety control\n');
  write('references/toolchain.md', '# Toolchain reference\n');
  write('archive/sources/raw.md', '# Raw source\n');

  const stats = kb.scanFrontmatter(fixture);
  fs.rmSync(fixture, { recursive: true, force: true });
  assert(stats.totalMd === 3 && stats.withFrontmatter === 1,
    `frontmatter denominator includes generated/raw files: ${JSON.stringify(stats)}`);
  assert(stats.missingFrontmatter.join(',') === 'primary/domain/_SUPERSEDED.md,references/toolchain.md',
    `frontmatter policy hid a real knowledge file or included generated output: ${JSON.stringify(stats)}`);
});

test('knowledge index generator updates visible date and counts from repository truth', () => {
  const generator = require(path.join(HOME, 'engineering-assets/tools/knowledge-index.cjs'));
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-index-metadata-'));
  const write = (relative) => {
    const file = path.join(fixture, 'knowledge', ...relative.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '---\nname: fixture\n---\n# Fixture\n', 'utf8');
  };
  write('primary/a.md');
  write('primary/nested/b.md');
  write('primary/examples/not-counted.md');
  write('archive/sources/source.md');
  write('python-basics/python.md');
  write('linear-algebra/linear.md');
  write('methodology/method.md');
  write('references/reference.md');
  write('docs/templates/template.md');
  const existing = [
    '# 知识库索引',
    '',
    '> 最后更新: 2026-07-18 | 文档: 1 篇 primary + 1 篇 source + 1 篇 鸢尾花书蒸馏 + 1 篇 methodology + 1 篇 references + 1 篇 templates',
    '',
  ].join('\n');
  const updated = generator.updateIndexMetadata(existing, fixture, '2026-07-28');
  fs.rmSync(fixture, { recursive: true, force: true });

  assert(updated.includes('最后更新: 2026-07-28'), `generator did not update visible date: ${updated}`);
  assert(updated.includes('文档: 2 篇 primary + 1 篇 source + 2 篇 鸢尾花书蒸馏 + 1 篇 methodology + 1 篇 references + 1 篇 templates'),
    `generator did not derive visible counts: ${updated}`);
  assert(!updated.includes('最后更新: 2026-07-18'), 'generator retained stale visible metadata');
  assert(generator.generationDateFor(existing, [], Date.parse('2026-07-28T00:00:00.000Z')) === '2026-07-18',
    'read-only index check would expire solely because the calendar day changed');
  assert(generator.generationDateFor(existing, ['--write'], Date.parse('2026-07-28T00:00:00.000Z')) === '2026-07-28',
    'explicit index rebuild did not stamp its real rebuild date');
});

test('kb index freshness follows repository counts instead of expiring every day', () => {
  const kb = require(path.join(HOME, 'engine/scripts/kb-stats.cjs'));
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-index-freshness-'));
  const knowledge = path.join(fixture, 'engineering-assets', 'knowledge');
  fs.mkdirSync(knowledge, { recursive: true });
  fs.writeFileSync(path.join(knowledge, 'INDEX.md'), [
    '# Index',
    '> 最后更新: 2026-07-18 | 文档: 2 篇 primary + 3 篇 source + 4 篇 鸢尾花书蒸馏 + 5 篇 methodology + 6 篇 references + 7 篇 templates',
    '',
  ].join('\n'), 'utf8');
  const stats = {
    primaryNoExamples: 2,
    sources: 3,
    iris: 4,
    methodology: 5,
    references: 6,
    templates: 7,
    missingFrontmatter: [],
    wikiLinks: { broken: [] },
    semanticIndex: { freshness: { stale: false } },
  };
  const unchanged = kb.checkKnowledge({
    home: fixture,
    now: Date.parse('2026-07-28T00:00:00.000Z'),
    stats,
  });
  const drifted = kb.checkKnowledge({
    home: fixture,
    now: Date.parse('2026-07-28T00:00:00.000Z'),
    stats: { ...stats, references: 8 },
  });
  fs.rmSync(fixture, { recursive: true, force: true });

  assert(!unchanged.issues.some(issue => issue.code === 'knowledge_index_stale'),
    `unchanged index expired by date: ${JSON.stringify(unchanged.issues)}`);
  assert(drifted.issues.some(issue => issue.code === 'knowledge_index_stale'),
    `count drift was not detected: ${JSON.stringify(drifted.issues)}`);
});

test('semantic retrieval and quiet knowledge checks fail closed on a stale index', () => {
  const semanticPath = path.join(HOME, 'engine/scripts/semantic-search.cjs');
  const semanticSource = fs.readFileSync(semanticPath, 'utf8');
  assert(semanticSource.includes('if (require.main === module)'), 'semantic search is not safe to require as a library');

  delete require.cache[require.resolve(semanticPath)];
  const semantic = require(semanticPath);
  assert(typeof semantic.buildSemanticIndex === 'function', 'semantic index build API missing');
  assert(typeof semantic.inspectIndexFreshness === 'function', 'semantic freshness API missing');
  assert(typeof semantic.querySemantic === 'function', 'fail-closed semantic query API missing');

  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-stale-contract-'));
  const learningDir = path.join(fixture, 'memory', 'learnings');
  const knowledgeDir = path.join(fixture, 'engineering-assets', 'knowledge');
  fs.mkdirSync(learningDir, { recursive: true });
  fs.mkdirSync(path.join(knowledgeDir, 'primary'), { recursive: true });
  fs.writeFileSync(path.join(learningDir, 'alpha.md'), '# Alpha\nalpha handshake evidence\n', 'utf8');
  fs.writeFileSync(path.join(knowledgeDir, 'INDEX.md'), '# Knowledge index\n', 'utf8');

  const built = semantic.buildSemanticIndex({ home: fixture, now: Date.parse('2026-07-28T00:00:00.000Z') });
  assert(built.fileCount === 1, `fixture index count is wrong: ${JSON.stringify(built)}`);
  const fresh = semantic.inspectIndexFreshness({
    home: fixture,
    now: Date.parse('2026-07-28T00:30:00.000Z'),
  });
  assert(fresh.stale === false && fresh.changed === 0 && fresh.unindexed === 0,
    `new index was not fresh: ${JSON.stringify(fresh)}`);

  const freshQuery = semantic.querySemantic('alpha handshake', { home: fixture, topK: 3 });
  assert(freshQuery.ok === true && freshQuery.results.length === 1,
    `fresh index query failed: ${JSON.stringify(freshQuery)}`);

  const alphaPath = path.join(learningDir, 'alpha.md');
  fs.appendFileSync(alphaPath, 'new behavioral evidence\n', 'utf8');
  const changedAt = new Date('2026-07-28T01:00:00.000Z');
  fs.utimesSync(alphaPath, changedAt, changedAt);
  fs.writeFileSync(path.join(learningDir, 'beta.md'), '# Beta\nbeta trigger\n', 'utf8');

  const stale = semantic.inspectIndexFreshness({
    home: fixture,
    now: Date.parse('2026-07-28T01:30:00.000Z'),
  });
  assert(stale.stale === true && stale.changed === 1 && stale.unindexed === 1,
    `mtime/unindexed drift was missed: ${JSON.stringify(stale)}`);
  const blocked = semantic.querySemantic('alpha handshake', { home: fixture, topK: 3 });
  assert(blocked.ok === false && blocked.status === 'stale_index' && blocked.results.length === 0,
    `stale query returned untrustworthy results: ${JSON.stringify(blocked)}`);

  const kbPath = path.join(HOME, 'engine/scripts/kb-stats.cjs');
  const checked = spawnSync(process.execPath, [kbPath, '--home', fixture, '--check', '--quiet', '--json'], {
    cwd: HOME,
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
  });
  assert(checked.status !== 0, `quiet stale check false-greened: ${checked.stdout || checked.stderr}`);
  let payload;
  try { payload = JSON.parse(checked.stdout); }
  catch { throw new Error(`quiet check was not machine-readable JSON: ${checked.stdout || checked.stderr}`); }
  assert(payload.ok === false && payload.issues.some((issue) => issue.code === 'semantic_index_stale'),
    `stale issue missing from quiet check: ${JSON.stringify(payload)}`);
});

test('harness rules require verified evidence and explicit approval before promotion', () => {
  const candidatesPath = path.join(HOME, 'engine/scripts/harness-rule-candidates.cjs');
  assert(fs.existsSync(candidatesPath), 'harness rule candidate lifecycle is missing');
  delete require.cache[require.resolve(candidatesPath)];
  const candidates = require(candidatesPath);
  for (const name of ['stageCandidate', 'verifyCandidate', 'approveCandidate', 'promoteCandidate', 'readLedger']) {
    assert(typeof candidates[name] === 'function', `candidate lifecycle API missing: ${name}`);
  }

  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-rule-candidate-contract-'));
  const ledgerPath = path.join(fixture, 'var', 'maintenance', 'harness-rule-candidates.json');
  const rulesPath = path.join(fixture, 'docs', 'rules', '05-harness.md');
  fs.mkdirSync(path.dirname(rulesPath), { recursive: true });
  fs.writeFileSync(rulesPath, '# Harness rules\n\n## Promoted rules\n', 'utf8');
  const initialRules = fs.readFileSync(rulesPath, 'utf8');

  const staged = candidates.stageCandidate({
    title: 'Status-less hook payloads need explicit evidence',
    source: { kind: 'dream', ref: 'dream-output:42' },
    rootCause: 'A missing status field was interpreted as success.',
    verifiedFix: 'Parse the real payload shape and require explicit outcome evidence.',
    prevention: 'Fail closed until a real-shape behavioral regression proves PASS.',
    triggerConditions: ['A PostToolUse payload has no status field.'],
  }, {
    ledgerPath,
    stagedBy: 'memory-maintenance',
    now: '2026-07-28T02:00:00.000Z',
  });
  assert(staged.status === 'candidate' && staged.source.kind === 'dream',
    `Dream output skipped candidate state: ${JSON.stringify(staged)}`);
  assert(fs.readFileSync(rulesPath, 'utf8') === initialRules, 'staging changed the durable harness rules');

  const weak = candidates.stageCandidate({
    title: 'Unverified hunch',
    source: { kind: 'error', ref: 'error:weak' },
    rootCause: 'Unknown.',
    verifiedFix: '',
    prevention: '',
    triggerConditions: [],
  }, { ledgerPath, now: '2026-07-28T02:01:00.000Z' });
  assertThrows(() => candidates.verifyCandidate(weak.id, {
    ledgerPath,
    verifiedBy: 'contract-test',
    evidence: [{ kind: 'behavioral_test', result: 'PASS', command: 'node weak.cjs' }],
  }), /candidate.*incomplete|missing/i, 'incomplete experience was verified');

  const verified = candidates.verifyCandidate(staged.id, {
    ledgerPath,
    verifiedBy: 'contract-test',
    now: '2026-07-28T02:02:00.000Z',
    evidence: realBehaviorEvidence(fixture, 'statusless-hook-payload'),
  });
  assert(verified.status === 'verified' && verified.verification.evidence.length === 1,
    `candidate was not verified with evidence: ${JSON.stringify(verified)}`);
  assertThrows(() => candidates.promoteCandidate(staged.id, {
    ledgerPath,
    rulesPath,
    promotedBy: 'contract-test',
  }), /approved/i, 'verified-only candidate was promoted');
  assertThrows(() => candidates.approveCandidate(staged.id, {
    ledgerPath,
    approvedBy: 'contract-test',
    explicit: false,
  }), /explicit/i, 'implicit approval was accepted');

  const approved = candidates.approveCandidate(staged.id, {
    ledgerPath,
    approvedBy: 'user',
    explicit: true,
    now: '2026-07-28T02:03:00.000Z',
  });
  assert(approved.status === 'approved' && approved.approval.explicit === true,
    `explicit approval was not persisted: ${JSON.stringify(approved)}`);
  const rulesBeforeRejectedPromotion = fs.readFileSync(rulesPath, 'utf8');
  const ledgerBeforeRejectedPromotion = fs.readFileSync(ledgerPath, 'utf8');
  assertThrows(() => candidates.promoteCandidate(staged.id, {
    ledgerPath,
    rulesPath,
    promotedBy: '',
  }), /promotedBy/i, 'promotion without an accountable actor was accepted');
  assert(fs.readFileSync(rulesPath, 'utf8') === rulesBeforeRejectedPromotion,
    'failed promotion wrote the durable rules before validating prerequisites');
  assert(fs.readFileSync(ledgerPath, 'utf8') === ledgerBeforeRejectedPromotion,
    'failed promotion changed the lifecycle ledger');
  const promoted = candidates.promoteCandidate(staged.id, {
    ledgerPath,
    rulesPath,
    promotedBy: 'contract-test',
    now: '2026-07-28T02:04:00.000Z',
  });
  assert(promoted.status === 'promoted', `approved candidate was not promoted: ${JSON.stringify(promoted)}`);
  candidates.promoteCandidate(staged.id, { ledgerPath, rulesPath, promotedBy: 'contract-test' });
  const rules = fs.readFileSync(promoted.promotion.rulesPath, 'utf8');
  const marker = `<!-- harness-rule-candidate:${staged.id} -->`;
  assert(rules.split(marker).length - 1 === 1, 'promotion was not idempotent');
  assert(rules.includes('Trigger conditions') && rules.includes('Behavioral evidence')
    && rules.includes('trigger: "A PostToolUse payload has no status field."')
    && rules.includes(`candidate ${staged.id}`),
    'promoted rule lost its trigger/evidence boundary');
  const ledger = candidates.readLedger(ledgerPath);
  assert(ledger.candidates.find((item) => item.id === weak.id).status === 'candidate',
    'unverified weak experience escaped the candidate queue');
});

test('memory attribution records idempotent exposures with complete scoped identity', () => {
  const attributionPath = path.join(HOME, 'engine/sqlite/store-memory-attribution.cjs');
  const attribution = require(attributionPath);
  const { openDb } = require(path.join(HOME, 'engine/sqlite/index.cjs'));
  const wDb = openDb({ path: ':memory:' });

  assertThrows(() => attribution.recordExposure({
    projectId: 'project-a',
    memoryId: 'memory-a',
    retrievalId: 'retrieval-a',
    triggerKind: 'user-query',
    query: 'raw prompt must not be persisted',
  }, { db: wDb.db }), /sessionId/, 'anonymous exposure was accepted');

  const signal = {
    sessionId: 'session-a',
    projectId: 'project-a',
    memoryId: 'memory-a',
    retrievalId: 'retrieval-a',
    correlationId: 'prompt-a',
    triggerKind: 'user-query',
    query: 'raw prompt must not be persisted',
    rank: 1,
    confidence: 0.9,
  };
  const first = attribution.recordExposure(signal, { db: wDb.db, now: 1_000 });
  const duplicate = attribution.recordExposure(signal, { db: wDb.db, now: 1_001 });
  const rows = wDb.db.prepare('SELECT * FROM memory_retrieval_exposures').all();
  wDb.close();

  assert(first.created === true && duplicate.created === false,
    `exposure idempotency is missing: ${JSON.stringify({ first, duplicate })}`);
  assert(first.exposureId === duplicate.exposureId && rows.length === 1,
    `duplicate exposure rows were written: ${JSON.stringify(rows)}`);
  assert(rows[0].session_id === signal.sessionId
      && rows[0].project_id === signal.projectId
      && rows[0].memory_id === signal.memoryId
      && rows[0].retrieval_id === signal.retrievalId
      && rows[0].correlation_id === signal.correlationId,
  `scoped identity was not preserved: ${JSON.stringify(rows[0])}`);
  assert(/^[a-f0-9]{64}$/.test(rows[0].query_sha256 || ''), 'query hash is missing');
  assert(!JSON.stringify(rows).includes(signal.query), 'raw retrieval query leaked into attribution storage');
});

test('memory attribution records observed applications without accepting model adoption claims', () => {
  const attribution = require(path.join(HOME, 'engine/sqlite/store-memory-attribution.cjs'));
  const { openDb } = require(path.join(HOME, 'engine/sqlite/index.cjs'));
  const wDb = openDb({ path: ':memory:' });
  const identity = {
    sessionId: 'session-application',
    projectId: 'project-application',
    memoryId: 'memory-application',
    retrievalId: 'retrieval-application',
  };
  const exposure = attribution.recordExposure({
    ...identity,
    correlationId: 'prompt-application',
    triggerKind: 'user-query',
    query: 'fifo application evidence',
    confidence: 0.9,
  }, { db: wDb.db, now: 2_000 });

  assertThrows(() => attribution.recordApplication({
    ...identity,
    exposureId: exposure.exposureId,
    correlationId: 'tool-application',
    eventName: 'PostToolUse',
    toolName: 'Edit',
    action: 'edit rtl/fifo.sv',
    evidenceKind: 'observed-followup',
    evidenceStrength: 'weak',
    applied: true,
  }, { db: wDb.db }), /self claim|not accepted evidence/,
  'model adoption claim was accepted as application evidence');

  const signal = {
    ...identity,
    exposureId: exposure.exposureId,
    correlationId: 'tool-application',
    eventName: 'PostToolUse',
    toolName: 'Edit',
    action: 'edit rtl/fifo.sv',
    targetPath: 'rtl/fifo.sv',
    evidenceKind: 'observed-followup',
    evidenceStrength: 'weak',
  };
  const first = attribution.recordApplication(signal, { db: wDb.db, now: 2_100 });
  const duplicate = attribution.recordApplication(signal, { db: wDb.db, now: 2_101 });
  const rows = wDb.db.prepare('SELECT * FROM memory_applications').all();
  wDb.close();

  assert(first.created === true && duplicate.created === false && rows.length === 1,
    `application idempotency is missing: ${JSON.stringify({ first, duplicate, rows })}`);
  assert(rows[0].session_id === identity.sessionId
      && rows[0].project_id === identity.projectId
      && rows[0].memory_id === identity.memoryId
      && rows[0].retrieval_id === identity.retrievalId,
  `application identity chain was lost: ${JSON.stringify(rows[0])}`);
  assert(rows[0].evidence_kind === 'observed-followup'
      && rows[0].evidence_strength === 'weak'
      && rows[0].causal_claim === 'unproven',
  `temporal observation was promoted into adoption/causality: ${JSON.stringify(rows[0])}`);
  assert(/^[a-f0-9]{64}$/.test(rows[0].action_sha256 || ''), 'action hash is missing');
  assert(!JSON.stringify(rows).includes(signal.action), 'raw tool action leaked into attribution storage');
});

test('memory attribution accepts outcomes only from verification-gate evidence', () => {
  const attribution = require(path.join(HOME, 'engine/sqlite/store-memory-attribution.cjs'));
  const { openDb } = require(path.join(HOME, 'engine/sqlite/index.cjs'));
  const wDb = openDb({ path: ':memory:' });
  const identity = {
    sessionId: 'session-outcome',
    projectId: 'project-outcome',
    memoryId: 'memory-outcome',
    retrievalId: 'retrieval-outcome',
  };
  const exposure = attribution.recordExposure({
    ...identity,
    correlationId: 'prompt-outcome',
    triggerKind: 'user-query',
    query: 'verified fifo fix',
    confidence: 0.95,
  }, { db: wDb.db, now: 3_000 });
  const application = attribution.recordApplication({
    ...identity,
    exposureId: exposure.exposureId,
    correlationId: 'tool-edit-outcome',
    eventName: 'PostToolUse',
    toolName: 'Edit',
    action: 'edit rtl/fifo.sv',
    evidenceKind: 'observed-followup',
    evidenceStrength: 'weak',
  }, { db: wDb.db, now: 3_100 });

  const base = {
    ...identity,
    exposureId: exposure.exposureId,
    applicationId: application.applicationId,
    correlationId: 'tool-verify-outcome',
    verdict: 'pass',
    accepted: true,
    reason: 'exit code 0 with explicit PASS evidence',
    command: 'node engine/scripts/test-hooks/workflow-contracts.cjs',
    stdout: 'Summary: 28/28 passed, 0 failed',
    stderr: '',
  };
  assertThrows(() => attribution.recordOutcome({
    ...base,
    evidenceSource: 'model-report',
  }, { db: wDb.db }), /verification-gate/,
  'model-reported verification was accepted as outcome evidence');
  assertThrows(() => attribution.recordOutcome({
    ...base,
    evidenceSource: 'verification-gate',
    success: true,
  }, { db: wDb.db }), /self claim|not accepted evidence/,
  'success self-claim bypassed verification evidence');

  const signal = { ...base, evidenceSource: 'verification-gate' };
  const first = attribution.recordOutcome(signal, { db: wDb.db, now: 3_200 });
  assertThrows(() => attribution.recordOutcome({
    ...signal,
    verdict: 'fail',
    accepted: false,
    reason: 'conflicting replay must not flip the stored verdict',
  }, { db: wDb.db, now: 3_201 }), /conflicting outcome replay/,
  'conflicting verdict replay changed an existing evidence outcome');
  const duplicate = attribution.recordOutcome(signal, { db: wDb.db, now: 3_201 });
  const rows = wDb.db.prepare('SELECT * FROM memory_outcomes').all();
  const exposureStatus = wDb.db.prepare(
    'SELECT status FROM memory_retrieval_exposures WHERE exposure_id = ?',
  ).get(exposure.exposureId)?.status;
  wDb.close();

  assert(first.created === true && duplicate.created === false && rows.length === 1,
    `outcome idempotency is missing: ${JSON.stringify({ first, duplicate, rows })}`);
  assert(rows[0].session_id === identity.sessionId
      && rows[0].project_id === identity.projectId
      && rows[0].memory_id === identity.memoryId
      && rows[0].retrieval_id === identity.retrievalId
      && rows[0].application_id === application.applicationId,
  `outcome identity chain was lost: ${JSON.stringify(rows[0])}`);
  assert(rows[0].verdict === 'pass' && rows[0].accepted === 1
      && rows[0].evidence_source === 'verification-gate'
      && rows[0].causal_claim === 'unproven',
  `verification outcome was promoted into causal success: ${JSON.stringify(rows[0])}`);
  assert(exposureStatus === 'verified-pass',
    `verified exposure remained eligible for repeated attribution: ${exposureStatus}`);
  for (const key of ['command_sha256', 'stdout_sha256', 'stderr_sha256']) {
    assert(/^[a-f0-9]{64}$/.test(rows[0][key] || ''), `${key} is missing`);
  }
  assert(!JSON.stringify(rows).includes(signal.command)
      && !JSON.stringify(rows).includes(signal.stdout),
  'raw verification command/output leaked into attribution storage');
});

test('memory attribution observer skips its anchor and never crosses project boundaries', () => {
  const attribution = require(path.join(HOME, 'engine/sqlite/store-memory-attribution.cjs'));
  const { openDb } = require(path.join(HOME, 'engine/sqlite/index.cjs'));
  const wDb = openDb({ path: ':memory:' });
  const currentTool = {
    hook_event_name: 'PostToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: 'rtl/fifo.sv', old_string: 'a', new_string: 'b' },
    tool_response: { status: 0, stdout: 'updated', stderr: '' },
    session_id: 'session-observer',
  };
  const projectId = 'project-observer';
  attribution.recordExposure({
    sessionId: currentTool.session_id,
    projectId,
    memoryId: 'memory-prompt',
    retrievalId: 'retrieval-prompt',
    correlationId: 'prompt-observer',
    triggerKind: 'user-query',
    query: 'fifo fix',
    confidence: 0.9,
  }, { db: wDb.db, now: 4_000 });
  attribution.recordExposure({
    sessionId: currentTool.session_id,
    projectId,
    memoryId: 'memory-pretool',
    retrievalId: 'retrieval-pretool',
    correlationId: 'pretool-observer',
    triggerKind: 'task-context',
    query: 'rtl fifo file edit',
    confidence: 0.9,
    anchorTool: currentTool.tool_name,
    anchorInputSha256: attribution.toolInputSha256(currentTool),
  }, { db: wDb.db, now: 4_010 });

  const first = attribution.observePostTool(currentTool, {
    db: wDb.db,
    projectId,
    correlationId: 'tool-current',
    now: 4_100,
  });
  let rows = wDb.db.prepare('SELECT memory_id, evidence_kind, causal_claim FROM memory_applications').all();
  assert(first.recorded === 1 && first.anchorsConsumed === 1,
    `current-action anchor was not consumed/skipped: ${JSON.stringify(first)}`);
  assert(rows.length === 1 && rows[0].memory_id === 'memory-prompt',
    `PreToolUse exposure was falsely attributed to its current tool: ${JSON.stringify(rows)}`);

  attribution.recordExposure({
    sessionId: currentTool.session_id,
    projectId,
    memoryId: 'memory-missed-anchor',
    retrievalId: 'retrieval-missed-anchor',
    correlationId: 'pretool-missed-observer',
    triggerKind: 'task-context',
    query: 'late observer anchor recovery',
    confidence: 0.9,
    anchorTool: currentTool.tool_name,
    anchorInputSha256: attribution.toolInputSha256(currentTool),
  }, { db: wDb.db, now: 4_150 });

  const nextTool = {
    ...currentTool,
    tool_name: 'Bash',
    tool_input: { command: 'node engine/scripts/test-hooks/workflow-contracts.cjs' },
    tool_response: { status: 0, stdout: '29/29 passed', stderr: '' },
  };
  const second = attribution.observePostTool(nextTool, {
    db: wDb.db,
    projectId,
    correlationId: 'tool-next',
    now: 4_200,
  });
  rows = wDb.db.prepare('SELECT memory_id, evidence_kind, causal_claim FROM memory_applications').all();
  assert(second.recorded === 3 && second.anchorsConsumed === 1
      && rows.some(row => row.memory_id === 'memory-pretool')
      && rows.some(row => row.memory_id === 'memory-missed-anchor'),
    `eligible follow-up was not observed: ${JSON.stringify({ second, rows })}`);
  assert(rows.every(row => row.evidence_kind === 'observed-followup'
      && row.causal_claim === 'unproven'),
  `observer invented adoption/causality: ${JSON.stringify(rows)}`);

  const before = rows.length;
  const crossProject = attribution.observePostTool(nextTool, {
    db: wDb.db,
    projectId: 'project-other',
    correlationId: 'tool-other-project',
    now: 4_300,
  });
  const anonymous = attribution.observePostTool({ ...nextTool, session_id: '' }, {
    db: wDb.db,
    projectId,
    correlationId: 'tool-anonymous',
    now: 4_400,
  });
  const after = Number(wDb.db.prepare('SELECT COUNT(*) AS count FROM memory_applications').get().count);
  wDb.close();
  assert(crossProject.recorded === 0 && anonymous.rejected === true && after === before,
    `anonymous/cross-project/no-exposure events amplified writes: ${JSON.stringify({ crossProject, anonymous, before, after })}`);
});

test('memory attribution closes outcomes only from normalized verification-gate verdicts', () => {
  const attribution = require(path.join(HOME, 'engine/sqlite/store-memory-attribution.cjs'));
  const { openDb } = require(path.join(HOME, 'engine/sqlite/index.cjs'));
  const wDb = openDb({ path: ':memory:' });
  const payload = {
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'node engine/scripts/test-hooks/workflow-contracts.cjs' },
    tool_response: { status: 0, stdout: 'Summary: 31/31 passed, 0 failed', stderr: '' },
    session_id: 'verified-attribution-session',
    cwd: HOME,
  };
  const projectId = 'verified-attribution-project';
  attribution.recordExposure({
    sessionId: payload.session_id,
    projectId,
    memoryId: 'memory-verification-rule',
    retrievalId: 'retrieval-verification-rule',
    triggerKind: 'task-context',
    query: 'verify memory attribution contract',
    rank: 1,
    confidence: 0.95,
  }, { db: wDb.db, now: 5_000 });

  const untrusted = attribution.observeVerificationGateResult(payload, {
    source: 'postflight-observer',
    verification: { ok: true, reason: 'model says tests passed' },
  }, { db: wDb.db, projectId, now: 5_100 });
  assert(untrusted.rejected === true && untrusted.outcomesRecorded === 0,
    `untrusted verdict was accepted: ${JSON.stringify(untrusted)}`);
  assert(Number(wDb.db.prepare('SELECT COUNT(*) AS count FROM memory_outcomes').get().count) === 0,
    'untrusted verdict wrote an outcome');

  const trusted = attribution.observeVerificationGateResult(payload, {
    source: 'verification-gate',
    decision: 'allow',
    verification: { ok: true, reason: 'explicit PASS evidence in output' },
  }, { db: wDb.db, projectId, now: 5_200 });
  const rows = wDb.db.prepare(`
    SELECT session_id, project_id, memory_id, retrieval_id, correlation_id,
           verdict, accepted, evidence_source, causal_claim
    FROM memory_outcomes
  `).all();
  wDb.close();
  assert(trusted.recorded === 1 && trusted.outcomesRecorded === 1 && rows.length === 1,
    `trusted gate verdict did not close the chain: ${JSON.stringify({ trusted, rows })}`);
  assert(rows[0].session_id === payload.session_id
      && rows[0].project_id === projectId
      && rows[0].memory_id === 'memory-verification-rule'
      && rows[0].retrieval_id === 'retrieval-verification-rule'
      && Boolean(rows[0].correlation_id),
  `outcome identity chain is incomplete: ${JSON.stringify(rows[0])}`);
  assert(rows[0].verdict === 'pass' && rows[0].accepted === 1
      && rows[0].evidence_source === 'verification-gate'
      && rows[0].causal_claim === 'unproven',
  `trusted verdict semantics drifted: ${JSON.stringify(rows[0])}`);
});

test('postflight observer invokes memory attribution fail-open only for identified tool events', () => {
  const observer = require(path.join(HOME, 'engine/hooks/learning/postflight-observer.cjs'));
  const { openDb } = require(path.join(HOME, 'engine/sqlite/index.cjs'));
  const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-attribution-'));
  let dbSequence = 0;
  const openFreshDb = () => openDb({ path: path.join(dbRoot, `memory-${dbSequence += 1}.db`) });
  const calls = [];
  const warnings = [];
  const payload = {
    hook_event_name: 'PostToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: path.join(HOME, 'docs', 'rules', '05-harness.md') },
    tool_response: { status: 0, stdout: 'updated', stderr: '' },
    session_id: 'observer-attribution-session',
    cwd: HOME,
  };
  const result = observer.handlePayload(payload, {
    openDb: openFreshDb,
    projectId: 'observer-attribution-project',
    correlationId: 'observer-attribution-call',
    attributionObserver(input, options) {
      calls.push({ input, options });
      return { recorded: 0, anchorsConsumed: 0, rejected: false, reason: 'no-active-exposure' };
    },
    warn(value) { warnings.push(value); },
  });
  assert(calls.length === 1 && calls[0].input === payload,
    `identified PostToolUse attribution call count was ${calls.length}`);
  assert(calls[0].options.projectId === 'observer-attribution-project'
      && calls[0].options.correlationId === 'observer-attribution-call',
    `observer dropped attribution correlation identity: ${JSON.stringify({
      projectId: calls[0].options.projectId,
      correlationId: calls[0].options.correlationId,
    })}`);
  assert(result.actions.includes('memory:attribution') && result.attribution?.recorded === 0,
    `observer result does not expose attribution stage: ${JSON.stringify(result)}`);
  assert(warnings.length === 0 && result.dropped === false,
    `no-op attribution was treated as a dropped telemetry write: ${JSON.stringify({ warnings, result })}`);

  let failedCalls = 0;
  const failed = observer.handlePayload(payload, {
    openDb: openFreshDb,
    attributionObserver() { failedCalls += 1; throw new Error('fixture attribution unavailable'); },
    warn(value) { warnings.push(value); },
  });
  assert(failedCalls === 1 && failed.dropped === false && failed.attribution?.dropped === true,
    `attribution failure corrupted the observer: ${JSON.stringify(failed)}`);

  const anonymous = observer.handlePayload({ ...payload, session_id: '' }, {
    openDb: openFreshDb,
    attributionObserver() { throw new Error('anonymous event reached attribution'); },
  });
  assert(!anonymous.actions.includes('memory:attribution'),
    `anonymous event entered attribution: ${JSON.stringify(anonymous)}`);
});

test('memory governance documents define retrieval, freshness, retirement, and harness promotion boundaries', () => {
  const harnessRulesPath = path.join(HOME, 'docs', 'rules', '05-harness.md');
  assert(fs.existsSync(harnessRulesPath), 'durable harness rule document is missing');
  const harnessRules = fs.readFileSync(harnessRulesPath, 'utf8');
  for (const required of [
    '## Scope',
    '## Trigger conditions',
    '## Evidence boundaries',
    '## Rule promotion lifecycle',
    'candidate -> verified -> approved -> promoted',
    'consumer-specific watermark',
    'stale_index',
    'dry-run',
    'stage --input',
    'verify --id',
    'approve --id',
    '--explicit',
    'promote --id',
    'real RED -> GREEN',
  ]) {
    assert(harnessRules.includes(required), `harness rule contract missing: ${required}`);
  }
  assert(/Dream[^\n]+(?:must not|MUST NOT)[^\n]+(?:rule|promot)/i.test(harnessRules),
    'Dream auto-promotion prohibition is missing');

  const memoryRules = fs.readFileSync(path.join(HOME, 'memory', 'MEMORY_RULES.md'), 'utf8');
  assert(memoryRules.length < 9000, `memory policy is still an operational dump (${memoryRules.length} chars)`);
  for (const required of [
    '## Memory tiers',
    '## Retrieval triggers',
    '## Freshness and verification',
    '## Retention and retirement',
    'candidate -> verified -> approved -> promoted',
    'tool_success',
    'stale_index',
  ]) {
    assert(memoryRules.includes(required), `memory policy missing: ${required}`);
  }
  assert(/tool_success[^\n]+(?:not memory|不是记忆)/i.test(memoryRules),
    'runtime success telemetry is still treated as durable memory');

  const ruleIndex = fs.readFileSync(path.join(HOME, 'docs', 'rules', 'README.md'), 'utf8');
  assert(ruleIndex.includes('05-harness.md'), 'core rule index does not expose harness rules');
  const rootReadme = fs.readFileSync(path.join(HOME, 'README.md'), 'utf8');
  for (const required of ['docs/rules/05-harness.md', 'memory-knowledge-maintenance.cjs', 'harness-rule-candidates.cjs']) {
    assert(rootReadme.includes(required), `root README does not expose ${required}`);
  }
  for (const required of [
    '| `UserPromptSubmit` |',
    'prompt-context.cjs：同进程合并规则 capsule、只读事实查询；实际注入另记 exposure',
    '| `PreToolUse` |',
    'preflight-router.cjs（进程内路由）',
    '| `PostToolUseFailure` |',
    'postflight-router.cjs（同步状态与失败记忆）+ postflight-observer.cjs（异步失败遥测/弱归因观察）',
    '| `SessionStart` |',
    'session-bootstrap.cjs（单进程恢复/Dream/isolation）+ 到期维护（async，仅 startup）',
    '| `Stop` |',
    'stop-summary.cjs（同步上下文/进度）+ postflight-observer.cjs（异步透明度/成本/Skill-Evolve）',
  ]) {
    assert(rootReadme.includes(required), `root README hook topology missing: ${required}`);
  }
  assert(!rootReadme.includes('| `PostMessage` |') && !rootReadme.includes('| `PostStop` |'),
    'root README still lists nonexistent Hook events');
  assert(/memory-sqlite-sync\.cjs[^\n]+(?:dormant|未注册)/i.test(rootReadme),
    'dormant memory SQLite sync is still presented as active');
  assert(/Dream[^\n]+(?:候选|candidate)[^\n]+(?:批准|approval)/i.test(rootReadme),
    'root README still implies autonomous durable rule learning');
});

function main() {
  let passed = 0;
  let failed = 0;

  console.log('\nWorkflow contract regression tests\n');
  for (const t of tests) {
    process.stdout.write(`  ${t.name.padEnd(78)} `);
    try {
      t.fn();
      passed += 1;
      console.log('PASS');
    } catch (error) {
      failed += 1;
      console.log('FAIL');
      console.log(`    ${error.message}`);
    }
  }

  console.log(`\nSummary: ${passed}/${tests.length} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
