#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const { openDb } = require(path.join(ROOT, 'engine', 'sqlite', 'index.cjs'));
const {
  retrieveMemory,
  writeMemory,
} = require(path.join(ROOT, 'engine', 'sqlite', 'store-memory.cjs'));
const {
  collectHookEntries,
  validateHookScripts,
} = require(path.join(ROOT, 'engine', 'scripts', 'lib', 'hook-registry.cjs'));

function main() {
  const wDb = openDb({ path: ':memory:' });
  const written = writeMemory({
    namespace: 'learnings',
    name: 'readonly-retrieval',
    content: 'readonly retrieval evidence contract',
    description: 'readonly retrieval evidence contract',
    source: 'test',
    confidence: 1,
    scopeKind: 'global_harness',
    triggerKind: 'user_query',
    verificationState: 'verified',
    evidenceRef: 'test:read-only-hooks',
    validUntil: Date.now() + 86_400_000,
  }, { db: wDb.db });
  const results = retrieveMemory('readonly retrieval', {
    db: wDb.db,
    limit: 3,
    trackHit: false,
    scope: { triggerKind: 'user_query' },
  });
  assert.ok(results.length > 0, 'fixture must be retrievable');
  const stored = wDb.db.prepare('SELECT hit_count FROM facts WHERE id = ?').get(written.id);
  assert.equal(stored.hit_count, 0, 'read-only retrieval must not mutate hit_count');
  const timelessVerified = writeMemory({
    namespace: 'learnings',
    name: 'readonly-timeless-verified',
    content: 'readonly retrieval evidence contract without review date',
    description: 'verified label without a validity boundary',
    source: 'test',
    confidence: 1,
    scopeKind: 'global_harness',
    triggerKind: 'user_query',
    verificationState: 'verified',
    evidenceRef: 'test:missing-valid-until',
  }, { db: wDb.db });
  const currentOnly = retrieveMemory('readonly retrieval', {
    db: wDb.db,
    limit: 5,
    minConfidence: 0,
    trackHit: false,
    scope: { triggerKind: 'user_query' },
  });
  assert.ok(!currentOnly.some(result => result.id === timelessVerified.id),
    'verified fact without valid_until leaked into default retrieval');
  const unsupportedVerified = writeMemory({
    namespace: 'learnings',
    name: 'readonly-unsupported-verified',
    content: 'readonly retrieval evidence contract without evidence reference',
    description: 'verified label without evidence',
    source: 'test',
    confidence: 1,
    scopeKind: 'global_harness',
    triggerKind: 'user_query',
    verificationState: 'verified',
    validUntil: Date.now() + 86_400_000,
  }, { db: wDb.db });
  const supportedOnly = retrieveMemory('readonly retrieval', {
    db: wDb.db,
    limit: 5,
    minConfidence: 0,
    trackHit: false,
    scope: { triggerKind: 'user_query' },
  });
  assert.ok(!supportedOnly.some(result => result.id === unsupportedVerified.id),
    'verified fact without evidence_ref leaked into default retrieval');
  const dreamCandidate = writeMemory({
    namespace: 'learnings',
    name: 'readonly-retrieval-dream-candidate',
    content: 'status: review_required\nreadonly retrieval evidence contract',
    description: 'unverified dream candidate',
    source: 'script:dream',
    confidence: 1,
    scopeKind: 'global_harness',
    triggerKind: 'user_query',
  }, { db: wDb.db });
  const safeResults = retrieveMemory('readonly retrieval', {
    db: wDb.db,
    limit: 5,
    minConfidence: 0,
    trackHit: false,
    scope: { triggerKind: 'user_query' },
  });
  assert.ok(!safeResults.some(result => result.id === dreamCandidate.id),
    'review-required Dream candidate leaked into default retrieval');
  const reviewResults = retrieveMemory('readonly retrieval', {
    db: wDb.db,
    limit: 5,
    minConfidence: 0,
    trackHit: false,
    includeCandidates: true,
    scope: { triggerKind: 'user_query' },
  });
  assert.ok(reviewResults.some(result => result.id === dreamCandidate.id),
    'explicit candidate review can no longer retrieve Dream candidates');

  const dreamStartup = require(path.join(ROOT, 'engine', 'scripts', 'dream-startup-inject.cjs'));
  const dreamClaim = writeMemory({
    namespace: 'learnings',
    name: 'dream-text-claimed-verified',
    content: '# Dream claimed learning\nstatus: verified\nUNVERIFIED_DREAM_TEXT_BYPASS',
    description: 'UNVERIFIED_DREAM_TEXT_BYPASS',
    source: 'script:dream',
    confidence: 1,
    projectId: 'project-a',
    scopeKind: 'repository',
    triggerKind: 'session_start',
    verificationState: 'candidate',
  }, { db: wDb.db });
  const scopedDream = writeMemory({
    namespace: 'learnings',
    name: 'dream-scoped-verified',
    content: '# Dream verified learning\nstatus: verified\nSCOPED_DREAM_VERIFIED',
    description: 'SCOPED_DREAM_VERIFIED',
    source: 'script:dream',
    confidence: 1,
    projectId: 'project-a',
    scopeKind: 'repository',
    triggerKind: 'session_start',
    verificationState: 'verified',
    evidenceRef: 'test:dream-scoped-red-green',
    validUntil: Date.now() + 86_400_000,
  }, { db: wDb.db });
  const otherProjectDream = writeMemory({
    namespace: 'learnings',
    name: 'dream-other-project-verified',
    content: '# Dream verified learning\nstatus: verified\nOTHER_PROJECT_DREAM',
    description: 'OTHER_PROJECT_DREAM',
    source: 'script:dream',
    confidence: 1,
    projectId: 'project-b',
    scopeKind: 'repository',
    triggerKind: 'session_start',
    verificationState: 'verified',
    evidenceRef: 'test:dream-other-project-red-green',
    validUntil: Date.now() + 86_400_000,
  }, { db: wDb.db });
  const startupLearnings = dreamStartup.getRecentDreamLearnings(90, {
    db: wDb.db,
    scope: {
      projectId: 'project-a',
      triggerKind: 'session_start',
      triggerSignature: null,
    },
  });
  assert.ok(startupLearnings.some(result => result.id === scopedDream.id),
    'current verified Dream learning in the selected project was not retrievable');
  assert.ok(!startupLearnings.some(result => result.id === dreamClaim.id),
    'Dream content text falsely upgraded a candidate into startup context');
  assert.ok(!startupLearnings.some(result => result.id === otherProjectDream.id),
    'Dream startup retrieval leaked a verified fact from another project');
  wDb.close();

  const observer = require(path.join(ROOT, 'engine', 'hooks', 'learning', 'postflight-observer.cjs'));
  const parseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-verified-qualification-'));
  const parseDir = path.join(parseRoot, 'learnings');
  const parseErrorsDir = path.join(parseRoot, 'errors');
  fs.mkdirSync(parseDir, { recursive: true });
  fs.mkdirSync(parseErrorsDir, { recursive: true });
  const claimedWithoutEvidence = path.join(parseDir, 'missing-evidence.md');
  const claimedWithoutValidity = path.join(parseDir, 'missing-validity.md');
  const legacyError = path.join(parseErrorsDir, 'legacy-error.md');
  const legacyMilestone = path.join(parseDir, 'legacy-milestone.md');
  fs.writeFileSync(claimedWithoutEvidence, [
    '---',
    'name: missing-evidence',
    'scope_kind: global_harness',
    'trigger_kind: user_query',
    'verification_state: verified',
    'valid_until: 2099-01-01T00:00:00Z',
    '---',
    '# Unsupported claim',
  ].join('\n'), 'utf8');
  fs.writeFileSync(claimedWithoutValidity, [
    '---',
    'name: missing-validity',
    'scope_kind: global_harness',
    'trigger_kind: user_query',
    'verification_state: verified',
    'evidence_ref: test:historical-pass',
    '---',
    '# Timeless claim',
  ].join('\n'), 'utf8');
  fs.writeFileSync(legacyError, [
    '---',
    'name: legacy-error',
    'type: error',
    '---',
    '# Legacy error record',
  ].join('\n'), 'utf8');
  fs.writeFileSync(legacyMilestone, [
    '---',
    'name: legacy-milestone',
    'type: milestone',
    '---',
    '# Legacy milestone record',
  ].join('\n'), 'utf8');
  try {
    const noEvidence = observer.parseMemoryFact(claimedWithoutEvidence, parseRoot);
    const noValidity = observer.parseMemoryFact(claimedWithoutValidity, parseRoot);
    const normalizedError = observer.parseMemoryFact(legacyError, parseRoot);
    const normalizedMilestone = observer.parseMemoryFact(legacyMilestone, parseRoot);
    assert.equal(noEvidence?.verificationState, 'needs_reverify',
      'explicit verified claim without evidence_ref was not downgraded');
    assert.equal(noValidity?.verificationState, 'needs_reverify',
      'explicit verified claim without valid_until was not downgraded');
    assert.equal(normalizedError?.namespace, 'errors',
      'legacy singular error type was not normalized to the SQLite namespace');
    assert.equal(normalizedMilestone?.namespace, 'learnings',
      'unknown legacy type overrode the directory-backed SQLite namespace');
  } finally {
    fs.rmSync(parseRoot, { recursive: true, force: true });
  }

  const modeIsolationPath = path.join(
    os.tmpdir(),
    `claude-sqlite-mode-isolation-${process.pid}-${Date.now()}.db`,
  );
  let writableDb;
  let readonlyDb;
  try {
    writableDb = openDb({ path: modeIsolationPath });
    const writableStats = writableDb.stats();
    assert.ok(writableStats.pageCount > 0,
      `SQLite stats returned an invalid page count: ${JSON.stringify(writableStats)}`);
    assert.equal(writableStats.walMode, true,
      `SQLite stats did not report the active WAL mode: ${JSON.stringify(writableStats)}`);
    readonlyDb = openDb({ path: modeIsolationPath, readonly: true });
    assert.notEqual(readonlyDb, writableDb,
      'readonly open must not reuse a cached writable connection');
    assert.throws(
      () => readonlyDb.db.exec('CREATE TABLE forbidden_write(value TEXT)'),
      /read.?only|attempt to write/i,
      'readonly connection unexpectedly accepted a write',
    );
  } finally {
    for (const connection of new Set([readonlyDb, writableDb].filter(Boolean))) connection.close();
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(`${modeIsolationPath}${suffix}`, { force: true });
    }
  }

  const initIsolationPath = path.join(
    os.tmpdir(),
    `claude-sqlite-init-isolation-${process.pid}-${Date.now()}.db`,
  );
  let rawDb;
  let initializedDb;
  try {
    rawDb = openDb({ path: initIsolationPath, noInit: true });
    initializedDb = openDb({ path: initIsolationPath });
    assert.notEqual(initializedDb, rawDb,
      'normal open must not reuse a cached noInit connection');
    const migrations = initializedDb.db.prepare(
      "SELECT COUNT(*) AS count FROM _migrations",
    ).get();
    assert.ok(migrations.count > 0, 'normal open did not apply pending migrations');
  } finally {
    for (const connection of new Set([initializedDb, rawDb].filter(Boolean))) connection.close();
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(`${initIsolationPath}${suffix}`, { force: true });
    }
  }

  const ruleLoader = require(path.join(ROOT, 'engine', 'scripts', 'rule-loader.cjs'));
  assert.equal(typeof ruleLoader.injectionMemoPath, 'function');
  const memoPath = ruleLoader.injectionMemoPath('session/test', {
    tempRoot: path.join(os.tmpdir(), 'claude-readonly-contract'),
  });
  assert.ok(memoPath.startsWith(os.tmpdir()), `rule memo must live under temp: ${memoPath}`);
  assert.ok(!memoPath.includes(`${path.sep}var${path.sep}`), `rule memo must not live under repository var: ${memoPath}`);

  const auditRules = ruleLoader.evaluate('\u91cd\u65b0\u5ba1\u8ba1\u4e00\u4e0b\u8bb0\u5fc6\u5c42\u529f\u80fd\u3002') || [];
  const auditRefs = Array.isArray(auditRules)
    ? auditRules.map(rule => rule.file)
    : (auditRules.ruleRefs || []).map(rule => rule.file);
  assert.ok(!auditRefs.includes('03-gates.md'),
    `read-only audit was misclassified as a new feature: ${auditRefs.join(',')}`);

  const featureRules = ruleLoader.evaluate('\u521b\u5efa\u4e00\u4e2a\u65b0\u529f\u80fd') || [];
  const featureRefs = Array.isArray(featureRules)
    ? featureRules.map(rule => rule.file)
    : (featureRules.ruleRefs || []).map(rule => rule.file);
  assert.ok(featureRefs.includes('03-gates.md'),
    `explicit new feature no longer loads the requirements gate: ${featureRefs.join(',')}`);

  const ragSkill = fs.readFileSync(path.join(ROOT, 'skills', 'rag-skill', 'SKILL.md'), 'utf8');
  assert.ok(!/SCENE_CARDS[^\n]*L\d+|L\d+-L\d+/.test(ragSkill),
    'rag-skill still binds mutable scene cards to stale line ranges');
  assert.ok(ragSkill.includes('rg -n') && ragSkill.includes('^##'),
    'rag-skill must locate scene sections by stable Markdown heading anchors');
  const sceneCards = fs.readFileSync(
    path.join(ROOT, 'engineering-assets', 'knowledge', 'SCENE_CARDS.md'),
    'utf8',
  );
  assert.ok(!/L\d+-L\d+/.test(sceneCards.slice(0, 2000)),
    'SCENE_CARDS overview still publishes self-invalidating line ranges');

  const memoryHook = require(path.join(ROOT, 'engine', 'scripts', 'memory-retrieve-hook.cjs'));
  const wikiBypass = memoryHook.retrieveContext({
    hook_event_name: 'UserPromptSubmit',
    prompt: '请检查记忆 wiki 链接',
    cwd: ROOT,
  }, {
    recentlyInjected: () => false,
    markInjected: () => {},
    doMemoryQuery: () => [{
      memoryId: null,
      namespace: 'learnings',
      name: 'trusted-sqlite-fact',
      summary: 'trusted SQLite fact references [[unverified-markdown-note]]',
      confidence: 1,
      source: 'test',
      sourceKey: 'test:trusted-sqlite-fact',
      status: 'active',
      updatedAt: Date.now(),
    }],
    resolveWikiLinks: () => ({
      resolved: [{
        name: 'unverified-markdown-note',
        file: 'projects/other-project.md',
        summary: 'UNVERIFIED_MARKDOWN_WIKI_BYPASS',
      }],
      unresolved: [],
    }),
  });
  const wikiContext = wikiBypass?.hookSpecificOutput?.additionalContext || '';
  assert.ok(wikiContext.includes('trusted SQLite fact'),
    'strict SQLite result was not injected by the memory hook');
  assert.ok(!wikiContext.includes('UNVERIFIED_MARKDOWN_WIKI_BYPASS'),
    'wiki-link expansion injected Markdown outside SQLite scope/trust filtering');
  assert.equal(typeof memoryHook.memoryHintCacheFile, 'function');
  const cachePath = memoryHook.memoryHintCacheFile({
    tempRoot: path.join(os.tmpdir(), 'claude-readonly-contract'),
  });
  assert.ok(cachePath.startsWith(os.tmpdir()), `memory hint cache must live under temp: ${cachePath}`);

  const settingsFile = path.join(ROOT, 'settings.json');
  const entries = collectHookEntries({ files: [settingsFile] });
  const memoryRetrieve = entries.filter(entry => entry.command.includes('memory-retrieve-hook.cjs'));
  assert.equal(memoryRetrieve.length, 0,
    'memory retrieval still starts as an independent Hook process');
  const promptContext = entries.find(entry => entry.point === 'UserPromptSubmit'
    && entry.command.includes('prompt-context.cjs'));
  assert.ok(promptContext && !promptContext.isAsync,
    'prompt-time rule and memory retrieval router is missing');
  const promptSource = fs.readFileSync(
    path.join(ROOT, 'engine', 'scripts', 'hooks', 'prompt-context.cjs'), 'utf8');
  assert.match(promptSource, /memory-retrieve-hook\.cjs/,
    'prompt router lost read-only memory retrieval');
  assert.match(promptSource, /postflight-observer\.cjs/,
    'prompt router lost explicit correction observation');
  assert.ok(!memoryRetrieve.some(entry => entry.point === 'PreToolUse'),
    'memory retrieval must not start a second process on the PreToolUse hot path');
  const preflight = entries.filter(entry => entry.point === 'PreToolUse');
  assert.equal(preflight.length, 1, 'PreToolUse must remain a single router process');
  assert.match(preflight[0].command, /preflight-router\.cjs/);

  const crossLink = entries.filter(entry => entry.command.includes('cross-link-memory.cjs'));
  assert.ok(!crossLink.some(entry => entry.point === 'PostToolUse'),
    'cross-link must not loop after every successful tool');
  assert.equal(crossLink.length, 0, 'cross-link still starts as an independent process');
  const failureRouter = entries.find(entry => entry.point === 'PostToolUseFailure'
    && entry.command.includes('postflight-router.cjs'));
  assert.ok(failureRouter && !failureRouter.isAsync,
    'cross-link must synchronously inject through the current failure router');

  const retrieveScript = fs.readFileSync(
    path.join(ROOT, 'engine', 'scripts', 'memory-retrieve.sh'),
    'utf8'
  );
  assert.match(retrieveScript, /engineering-assets\/knowledge/,
    'manual retrieval must search the governed engineering knowledge root');
  assert.ok(!retrieveScript.includes('"$HOME_DIR/knowledge"'),
    'manual retrieval still searches the removed legacy knowledge root');
  assert.match(retrieveScript, /trackHit\s*:\s*false/,
    'read-only retrieval must not mutate hit counters');
  assert.match(retrieveScript, /openDb\(\{\s*readonly\s*:\s*true\s*\}\)/,
    'manual retrieval must open SQLite in actual readonly mode');
  assert.match(retrieveScript, /db\s*:\s*wDb\.db/,
    'manual retrieval did not pass the readonly connection into the store');
  assert.ok(!retrieveScript.includes('mkdir -p "$INDEX_DIR"'),
    'a retrieval query must not create index directories');

  const maintenance = entries.find(entry => entry.point === 'SessionStart'
    && entry.matcher.split('|').includes('startup')
    && entry.command.includes('memory-knowledge-maintenance.cjs')
    && entry.command.includes('--auto')
    && entry.command.includes('--execute'));
  assert.ok(maintenance && maintenance.isAsync,
    'periodic memory maintenance must run asynchronously in guarded auto-execute mode');
  assert.ok(!entries.some(entry => entry.command.includes('memory-health-score.sh')),
    'unreliable Git Bash/WSL memory health scorer must not remain active');

  const stopObserver = entries.find(entry => entry.point === 'Stop'
    && entry.command.includes('postflight-observer.cjs'));
  assert.ok(stopObserver && stopObserver.isAsync,
    'Skill-Evolve must run inside the bounded async Stop observer so retention can advance');
  const observerSource = fs.readFileSync(
    path.join(ROOT, 'engine', 'hooks', 'learning', 'postflight-observer.cjs'), 'utf8');
  assert.match(observerSource, /skill-evolve\.cjs/,
    'Stop observer lost the Skill-Evolve consumer');

  const missing = validateHookScripts({ files: [settingsFile] }).missing;
  assert.equal(missing.length, 0,
    `active hook scripts must exist: ${missing.map(item => item.source).join(', ')}`);

  process.stdout.write('READ_ONLY_HOOKS_RESULT: PASS\n');
}

main();
