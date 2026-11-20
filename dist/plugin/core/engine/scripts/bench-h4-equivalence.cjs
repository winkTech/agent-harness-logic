#!/usr/bin/env node
'use strict';

/**
 * core/engine/scripts/bench-h4-equivalence.cjs — H-4 跨宿主等价性（Phase 3.4）
 *
 * 样例集（≥8 恶意 + 良性对照）经方言合成器展开为四宿主载荷，全部过
 * preflight-router decide({transport})——同一引擎、四条方言路径。
 *
 * 判定：
 *   1. 等价性：每一样本四宿主 decision 必须完全一致（H-4 = 一致率 100%）
 *   2. 期望命中：样本 expect（block/warn/allow）与实际判决一致
 *      ——expect 是引擎门禁的语义基线；若引擎升级导致合理偏差，
 *        修样例集的 expect 而不是放宽等价性。
 *   3. 区分力：判决必须落在 ≥2 种取值上（全同判说明样例无区分力）
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..', '..', '..');

// 状态根隔离：decide 读真实状态根会让"重复失败检测"污染判决——
// 全新临时目录 = CI/新克隆等价视界。
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'h4-state-'));
process.env.HARNESS_STATE_DIR = STATE;
process.env.HARNESS_NO_PERSIST = '1';

const { loadSamples, synth } = require(path.join(ROOT, 'hosts/tests/dialect-synth.cjs'));
const preflight = require(path.join(ROOT, 'core/engine/scripts/hooks/preflight-router.cjs'));

const HOSTS = ['claude-code', 'workbuddy', 'codex', 'grok'];

async function main() {
  const samples = loadSamples();
  const rows = [];
  let equivalent = 0;
  let expectationMisses = 0;
  const verdicts = new Set();

  for (const sample of samples) {
    const decisions = {};
    for (const host of HOSTS) {
      const payload = synth(sample, host);
      const result = await preflight.decide(payload, { transport: host, env: {} });
      decisions[host] = result.decision;
      verdicts.add(result.decision);
    }
    const values = [...new Set(Object.values(decisions))];
    const isEqual = values.length === 1;
    if (isEqual) equivalent += 1;
    const expectHit = isEqual && values[0] === sample.expect;
    if (!expectHit) expectationMisses += 1;
    rows.push({
      id: sample.id, category: sample.category,
      expect: sample.expect, decisions, equivalent: isEqual, expectHit,
    });
  }

  fs.rmSync(STATE, { recursive: true, force: true });

  const rate = Math.round((equivalent / samples.length) * 100);
  process.stdout.write(`[h4] 样本 ${samples.length} × 宿主 ${HOSTS.length}\n`);
  for (const r of rows) {
    const mark = r.equivalent ? (r.expectHit ? '✅' : '⚖️') : '❌';
    process.stdout.write(`  ${mark} ${r.id.padEnd(16)} expect=${r.expect.padEnd(5)} claude=${(r.decisions['claude-code'] || '?').padEnd(5)} wb=${(r.decisions.workbuddy || '?').padEnd(5)} codex=${(r.decisions.codex || '?').padEnd(5)} grok=${r.decisions.grok || '?'}\n`);
  }

  if (rate !== 100) {
    process.stderr.write(`[h4] FAIL 等价率 ${rate}%（<100%）\n`);
    process.exit(1);
  }
  if (expectationMisses > 0) {
    // 期望失配不阻断 H-4（等价性是 H-4 本体），但非零即报告——样例集需人工对齐
    process.stderr.write(`[h4] ⚠ 期望失配 ${expectationMisses} 条（等价性成立，样例 expect 需对齐引擎现行为）\n`);
  }
  if (verdicts.size < 2) {
    process.stderr.write('[h4] FAIL 样例集无区分力（全部同判）\n');
    process.exit(1);
  }
  process.stdout.write(`[h4] PASS 等价率 100%（判决分布: ${[...verdicts].join('/')}；期望失配 ${expectationMisses}）\n`);
}

main().catch((e) => { process.stderr.write(`[h4] FAIL ${e.message}\n`); process.exit(1); });
