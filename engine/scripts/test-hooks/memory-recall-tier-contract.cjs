#!/usr/bin/env node
'use strict';

/**
 * memory-recall-tier-contract.cjs — 两层召回行为契约 (D5 修复)。
 *
 * 覆盖:
 *   1. verified 事实优先注入且不带未验证标注
 *   2. candidate 事实 (≥0.6) 在 verified 不足时补位, 注入行显式标注 候选(未验证)
 *   3. 低置信 candidate (<0.6) 不注入
 *   4. verified ≥3 条时不再补位 candidate (上限约束)
 *   5. 无触发词 → 零注入 (0 token 合同不变)
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.CLAUDE_HARNESS_NO_PERSIST = '1'; // 关缓存与归因持久化, 测试纯净

const ROOT = path.resolve(__dirname, '..', '..', '..');
const { openDb } = require(path.join(ROOT, 'engine/sqlite/index.cjs'));
const storeMemory = require(path.join(ROOT, 'engine/sqlite/store-memory.cjs'));
const { retrieveContext } = require(path.join(ROOT, 'engine/scripts/memory-retrieve-hook.cjs'));

function seedFact(db, name, confidence, verificationState) {
  const now = Date.now();
  const { id } = storeMemory.writeMemory({
    namespace: 'learnings',
    name,
    content: `FSM 状态机复位时序经验 ${name}: 三段式状态机的输出寄存必须挂在时钟沿`,
    description: `FSM 复位经验 ${name}`,
    source: 'manual',
    confidence,
  }, { db });
  // verified 事实按真实库形态: global_harness + user_query 触发 + 完整信任链;
  // candidate 保持 writeMemory 默认形态 (unscoped, 无 trigger) — 与存量 49 条一致。
  db.prepare(`
    UPDATE facts SET verification_state = ?, evidence_ref = ?, trigger_kind = ?,
                     valid_until = ?, scope_kind = COALESCE(?, scope_kind)
    WHERE id = ?
  `).run(
    verificationState,
    verificationState === 'verified' ? 'var/evidence/x.json' : null,
    verificationState === 'verified' ? 'user_query' : null,
    verificationState === 'verified' ? now + 90 * 86400000 : null,
    verificationState === 'verified' ? 'global_harness' : null,
    id,
  );
  return id;
}

function retrieve(db, message) {
  return retrieveContext(
    { hook_event_name: 'UserPromptSubmit', prompt: message, session_id: 'recall-test', cwd: ROOT },
    {
      openDb: () => ({ db, close() { /* shared handle */ } }),
      recentlyInjected: () => false,
      markInjected: () => {},
    },
  );
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-tier-'));
  const handle = openDb({ path: path.join(tmp, 'memory.db') });
  const db = handle.db;
  try {
    seedFact(db, 'verified-alpha', 0.7, 'verified');
    seedFact(db, 'cand-bravo', 0.7, 'candidate');
    seedFact(db, 'cand-lowconf', 0.4, 'candidate');

    // 1+2+3: verified 优先, candidate 标注补位, 低置信排除
    const out = retrieve(db, '查一下 FSM 状态机复位的既往经验');
    assert.ok(out, 'trigger message must inject');
    const text = out.hookSpecificOutput.additionalContext;
    assert.ok(text.includes('verified-alpha'), `verified fact missing: ${text}`);
    assert.ok(!new RegExp('候选\\(未验证[^\\n]*verified-alpha').test(text), 'verified fact must not carry candidate tag');
    assert.ok(text.includes('cand-bravo'), `candidate fact missing: ${text}`);
    assert.ok(new RegExp('候选\\(未验证[^\\n]*cand-bravo').test(text), `candidate must be tagged: ${text}`);
    assert.ok(!text.includes('cand-lowconf'), `low-confidence candidate must be excluded: ${text}`);

    // 4: verified 满 3 条后不再补位
    seedFact(db, 'verified-beta', 0.8, 'verified');
    seedFact(db, 'verified-gamma', 0.8, 'verified');
    const full = retrieve(db, '搜一下 FSM 状态机复位时序');
    const fullText = full.hookSpecificOutput.additionalContext;
    assert.ok(!fullText.includes('cand-bravo'),
      `with 3 verified facts, candidates must not pad: ${fullText}`);

    // 5: 无触发词 → 零注入
    assert.equal(retrieve(db, '好的谢谢'), null);

    console.log('memory-recall-tier-contract: all assertions passed');
  } finally {
    try { handle.close(); } catch { /* test cleanup */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* test cleanup */ }
  }
}

main();
