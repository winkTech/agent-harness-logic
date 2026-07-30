#!/usr/bin/env node
'use strict';

/**
 * guard-coverage-contract.cjs — 守卫覆盖率与受保护写入对账契约 (D9)。
 *
 * 锁定:
 *   1. bash-safety-guard 的每个危险模式类别都至少有一条真实 case 打到它
 *      (2026-07-30 首次运行报告 8/11 —— privilege-escalation / system-install /
 *       sql-destructive 三条防线写了但从未被验证过, 已补 case)
 *   2. 覆盖率判定必须来自**真实执行**返回的 category, 不是文本猜测
 *   3. protected-writes 对账规则: 无 reason 的放行=critical, 通配符令牌=high,
 *      过期令牌残留=medium; 一次性令牌被消费后审批文件为空属正常终态
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
process.env.CLAUDE_HARNESS_NO_PERSIST = '1';

const guardCoverage = require(path.join(ROOT, 'engine/scripts/guard-coverage.cjs'));
const health = require(path.join(ROOT, 'engine/scripts/memory-health-check.cjs'));

function main() {
  // ── 1+2. 覆盖率: 每个类别都被真实 case 命中 ──
  const report = guardCoverage.coverage({});
  assert.ok(report.categories >= 11, `expected >=11 guard categories, got ${report.categories}`);
  assert.ok(report.casesExecuted >= 25, `expected >=25 executed bash-safety cases, got ${report.casesExecuted}`);
  assert.deepEqual(report.uncovered, [],
    `guard categories without a single covering case: ${report.uncovered.join(', ')}`);
  assert.equal(report.coverageRate, 1);
  for (const entry of report.perCategory) {
    assert.ok(entry.patterns > 0, `${entry.category}: pattern count must be counted from the guard source`);
    assert.ok(entry.cases > 0, `${entry.category}: needs at least one executed case`);
  }

  // ── 3. protected-writes 对账三条规则 ──
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-coverage-'));
  try {
    const auditDir = path.join(tmp, 'var', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    const auditFile = path.join(auditDir, 'protected-writes.jsonl');
    const approvalFile = path.join(auditDir, 'protected-write-approvals.json');

    // 正常终态: 有理由的放行 + 空审批文件 (令牌已被消费) → 无问题
    fs.writeFileSync(auditFile, `${JSON.stringify({
      ts: new Date().toISOString(), file: 'matlab/gm.m', pattern: '**/matlab/**', reason: '用户会话中批准',
    })}\n`, 'utf8');
    fs.writeFileSync(approvalFile, '[]', 'utf8');
    let metrics = health.queryProtectedWrites(tmp);
    assert.equal(metrics.writes, 1);
    assert.equal(metrics.writesWithoutReason, 0,
      'a consumed one-time token must not be reported as an unapproved write');

    // 无 reason 的放行 → 必须被算成"无批准的写入"
    fs.appendFileSync(auditFile, `${JSON.stringify({
      ts: new Date().toISOString(), file: 'matlab/other.m', pattern: '**/matlab/**', reason: '  ',
    })}\n`, 'utf8');
    metrics = health.queryProtectedWrites(tmp);
    assert.equal(metrics.writes, 2);
    assert.equal(metrics.writesWithoutReason, 1);

    // 通配符令牌 + 过期令牌
    fs.writeFileSync(approvalFile, JSON.stringify([
      { path: 'matlab/*.m', reason: 'wildcard', expiresAt: new Date(Date.now() + 3600_000).toISOString() },
      { path: 'matlab/expired.m', reason: 'stale', expiresAt: new Date(Date.now() - 3600_000).toISOString() },
    ]), 'utf8');
    metrics = health.queryProtectedWrites(tmp);
    assert.equal(metrics.wildcardTokens, 1);
    assert.equal(metrics.expiredTokens, 1);
    assert.equal(metrics.liveTokens, 1);

    // 审计文件缺失时不得伪造数据
    const empty = health.queryProtectedWrites(path.join(tmp, 'nowhere'));
    assert.equal(empty.auditAvailable, false);
    assert.equal(empty.writes, 0);
    assert.equal(empty.writesWithoutReason, 0);

    console.log(`guard-coverage-contract: ${report.coveredCategories}/${report.categories} categories covered, `
      + `${report.casesExecuted} cases executed; all assertions passed`);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* cleanup */ }
  }
}

main();
