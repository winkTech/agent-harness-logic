#!/usr/bin/env node
'use strict';

/**
 * core/engine/scripts/test-hooks/cross-host-consistency-contract.test.cjs
 * Phase 3.4 合同——H-4 引擎层三/四方言等价性。
 *
 *   1. 样例集形态：≥8 恶意 + ≥2 良性；expect ∈ {allow,warn,block}；id 唯一
 *   2. 合成器：四宿主形态差异真实存在（grok 工具别名/codex eventType/camelCase）
 *   3. transport 层：grok 载荷 normalize 后工具名归一（run_terminal_command→Bash）
 *   4. H-4 引擎层等价性：全部样例 × 四宿主 decide 同判（= 100%）
 *   5. 区分力：判决 ≥2 种取值
 *   6. 恶意样本 ≥1 条 expect=block（H-3① 样本供给面成立）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');

// 状态根隔离（同 bench-h4：decide 的重复失败检测读真实状态根）
process.env.HARNESS_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'h4c-state-'));
process.env.HARNESS_NO_PERSIST = '1';
process.env.CLAUDE_HARNESS_NO_PERSIST = '1';

const { loadSamples, synth } = require(path.join(ROOT, 'hosts/tests/dialect-synth.cjs'));
const { ingest } = require('../transport/index.cjs');

const HOSTS = ['claude-code', 'workbuddy', 'codex', 'grok'];

test('样例集形态（≥8 恶意 + ≥2 良性 + expect 合法 + id 唯一）', () => {
  const samples = loadSamples();
  const ids = new Set(samples.map((s) => s.id));
  assert.equal(ids.size, samples.length, 'id 唯一');
  const malicious = samples.filter((s) => s.category === 'malicious');
  const benign = samples.filter((s) => s.category === 'benign');
  assert.ok(malicious.length >= 8, `恶意样例 ≥8, 实际 ${malicious.length}`);
  assert.ok(benign.length >= 2, `良性对照 ≥2, 实际 ${benign.length}`);
  for (const s of samples) {
    assert.ok(['allow', 'warn', 'block'].includes(s.expect), `${s.id} expect 非法`);
    assert.ok(s.tool && s.toolInput, `${s.id} 缺 tool/toolInput`);
  }
  assert.ok(samples.some((s) => s.expect === 'block'), 'H-3① 供给：≥1 条 block 样本');
});

test('合成器方言差异真实存在', () => {
  const [first] = loadSamples();
  const claude = synth(first, 'claude-code');
  const wb = synth(first, 'workbuddy');
  const grok = synth(first, 'grok');
  const codex = synth(first, 'codex');
  assert.ok('hook_event_name' in claude && 'tool_name' in claude, 'claude snake_case');
  assert.ok('hookEventName' in wb && 'toolName' in wb, 'workbuddy camelCase');
  assert.ok('eventType' in codex && codex.eventType === 'tool.pre', 'codex 中性 eventType');
  if (first.tool === 'Bash') {
    assert.equal(grok.tool_name, 'run_terminal_command', 'grok Bash 别名');
  }
});

test('transport 层: grok 载荷归一后工具名回 canonical', () => {
  const { transport, payload } = ingest(
    { hook_event_name: 'PreToolUse', tool_name: 'run_terminal_command', tool_input: { command: 'ls' }, session_id: 't' },
    { transport: 'grok', argv: [], env: {} },
  );
  assert.equal(transport, 'grok');
  assert.equal(payload.toolName || payload.tool_name, 'Bash', '别名必须归一');
});

test('H-4: 全样本四宿主同判（等价性 100%）', async () => {
  const preflight = require('../hooks/preflight-router.cjs');
  const samples = loadSamples();
  const verdicts = new Set();
  for (const sample of samples) {
    const decisions = {};
    for (const host of HOSTS) {
      const r = await preflight.decide(synth(sample, host), { transport: host, env: {} });
      decisions[host] = r.decision;
      verdicts.add(r.decision);
    }
    const values = [...new Set(Object.values(decisions))];
    assert.equal(values.length, 1, `${sample.id} 四宿主不同判: ${JSON.stringify(decisions)}`);
    assert.equal(values[0], sample.expect, `${sample.id} 期望失配: expect=${sample.expect} 实际=${values[0]}`);
  }
  assert.ok(verdicts.size >= 2, `区分力: 判决须 ≥2 种, 实际 ${[...verdicts].join('/')}`);
});
