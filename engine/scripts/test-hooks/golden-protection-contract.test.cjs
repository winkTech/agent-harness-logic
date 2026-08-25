#!/usr/bin/env node
/**
 * golden-protection-contract.test.cjs — file-protection-guard 的 golden 保护契约
 *
 * 本套件按**目标行为**断言（用户 2026-08-03 裁定的"新建豁免"）。在补丁应用前,
 * 标 [需补丁] 的用例会失败 —— 这是预期的, 它们正是用来证明补丁生效的。
 *
 * 立场: 这道门要防的是**因果倒置** —— RTL 调不通, 于是把 golden 改成 RTL 的样子。
 * 因此判据应落在"有没有可被倒置的对象"和"消费方 RTL 是不是刚被动过"这类硬事实上,
 * 而不是一律要人签一次字。新建豁免只放开结构上无从倒置的那一类, 其余原样收紧。
 *
 * 用法: node --test engine/scripts/test-hooks/golden-protection-contract.test.cjs
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../../..');
// 默认测线上守卫; GOLDEN_GUARD_PATH 可指向待评审的副本, 用于"补丁应用前先验证"。
const GUARD = process.env.GOLDEN_GUARD_PATH
  || path.join(ROOT, 'engine', 'scripts', 'hooks', 'file-protection-guard.cjs');
const { evaluate } = require(GUARD);

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

/** 建一份临时仓库固件; 返回常用路径。 */
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-protection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# fixture root marker\n', 'utf8');

  const withConsumer = path.join(root, 'engineering-assets', 'models', 'comm', 'withconsumer');
  fs.mkdirSync(path.join(withConsumer, 'src'), { recursive: true });
  fs.writeFileSync(path.join(withConsumer, 'manifest.json'),
    JSON.stringify({ asset_uid: 'model_withconsumer', kind: 'golden-model', implements_for: ['modx'] }), 'utf8');
  fs.writeFileSync(path.join(withConsumer, 'src', 'existing.m'), '% 既有 golden\n', 'utf8');

  const noConsumer = path.join(root, 'engineering-assets', 'models', 'comm', 'noconsumer');
  fs.mkdirSync(path.join(noConsumer, 'src'), { recursive: true });
  fs.writeFileSync(path.join(noConsumer, 'manifest.json'),
    JSON.stringify({ asset_uid: 'model_noconsumer', kind: 'golden-model' }), 'utf8');

  const rtlDir = path.join(root, 'cbb', 'modx', 'rtl');
  fs.mkdirSync(rtlDir, { recursive: true });
  const rtl = path.join(rtlDir, 'modx.sv');
  fs.writeFileSync(rtl, 'module modx; endmodule\n', 'utf8');

  return {
    root, rtl,
    newFile: path.join(withConsumer, 'src', 'brand_new.m'),      // 故意不创建
    existingFile: path.join(withConsumer, 'src', 'existing.m'),
    orphanNewFile: path.join(noConsumer, 'src', 'orphan_new.m'), // 目录无 implements_for
    unprotected: path.join(root, 'engineering-assets', 'cbb', 'notes.md'),
  };
}

/** 把 RTL 的 mtime 设成 ageMs 之前, 用来开关倒置信号。 */
function ageRtl(rtlPath, ageMs) {
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(rtlPath, when, when);
}

function judge(filePath, root, env = {}) {
  return evaluate(
    { tool_name: 'Write', tool_input: { file_path: filePath } },
    { cwd: root, env },
  );
}

// ── 新建豁免 (补丁引入) ─────────────────────────────────────────────────────

test('[需补丁] 新建 golden 文件 + 消费方 RTL 近期未改动 → 放行', (t) => {
  const f = fixture(t);
  ageRtl(f.rtl, FOUR_HOURS_MS * 3);                      // 远早于倒置窗口
  const out = judge(f.newFile, f.root);
  assert.notEqual(out.decision, 'block',
    `新建尚不存在的 golden 无可被倒置的对象, 不应拦: ${JSON.stringify(out.diagnostics)}`);
});

test('[需补丁] 新建 + 消费方 RTL 刚被改过 → 仍拦 (倒置窗口内)', (t) => {
  const f = fixture(t);
  ageRtl(f.rtl, 60 * 1000);                              // 1 分钟前
  const out = judge(f.newFile, f.root);
  assert.equal(out.decision, 'block', '倒置信号触发时, 新建 golden 同样需要批准');
});

test('[需补丁] 新建 + golden 目录无 implements_for → 仍拦 (fail-closed)', (t) => {
  const f = fixture(t);
  const out = judge(f.orphanNewFile, f.root);
  assert.equal(out.decision, 'block', '无 implements_for 则倒置无从评估, 必须 fail-closed');
});

// ── 既有保护面: 补丁不得放松 ────────────────────────────────────────────────

test('改动既有 golden + 无批准 → 拦 (补丁前后一致)', (t) => {
  const f = fixture(t);
  ageRtl(f.rtl, FOUR_HOURS_MS * 3);                      // 即使无倒置信号
  const out = judge(f.existingFile, f.root);
  assert.equal(out.decision, 'block', '改动既有 golden 一律要批准 —— 这是本门的主保护面');
});

test('批准 + 上游依据 → 放行', (t) => {
  const f = fixture(t);
  ageRtl(f.rtl, FOUR_HOURS_MS * 3);
  const out = judge(f.existingFile, f.root, {
    CLAUDE_PROTECTED_WRITE_APPROVAL: f.existingFile.replace(/\\/g, '/'),
    CLAUDE_PROTECTED_WRITE_REASON: '按算法规格修正量化标度',
    CLAUDE_PROTECTED_WRITE_BASIS: 'spec|knowledge/.../algorithm_spec.md',
  });
  assert.notEqual(out.decision, 'block', `上游依据应放行: ${JSON.stringify(out.diagnostics)}`);
});

test('批准 + 下游依据且无裁决 → 拦', (t) => {
  const f = fixture(t);
  ageRtl(f.rtl, FOUR_HOURS_MS * 3);
  const out = judge(f.existingFile, f.root, {
    CLAUDE_PROTECTED_WRITE_APPROVAL: f.existingFile.replace(/\\/g, '/'),
    CLAUDE_PROTECTED_WRITE_REASON: '依 RTL 实测行为调整',
    CLAUDE_PROTECTED_WRITE_BASIS: 'rtl-observation|波形抓取',
  });
  assert.equal(out.decision, 'block', 'basis.kind=rtl-observation 无 ruling 必须拒绝');
});

test('批准 + 理由含下游话术 → 拦 (即便 basis 自称上游)', (t) => {
  const f = fixture(t);
  ageRtl(f.rtl, FOUR_HOURS_MS * 3);
  const out = judge(f.existingFile, f.root, {
    CLAUDE_PROTECTED_WRITE_APPROVAL: f.existingFile.replace(/\\/g, '/'),
    CLAUDE_PROTECTED_WRITE_REASON: '对齐 RTL 输出, 让 cosim 通过',
    CLAUDE_PROTECTED_WRITE_BASIS: 'spec|某规格',
  });
  assert.equal(out.decision, 'block', '自述与话术冲突时应拒绝, 这是倒置的自述形状');
});

test('非受保护路径 → 放行', (t) => {
  const f = fixture(t);
  const out = judge(f.unprotected, f.root);
  assert.notEqual(out.decision, 'block', 'models/ 之外不属本门管辖');
});

// ── 令牌消费时点 (2026-08-04) ───────────────────────────────────────────────
//
// 实测缺陷: PreToolUse 的 commit 阶段直接扣 remainingWrites, 而工具那时还没跑。
// 一次被权限分类器否决的 Edit 把 remainingWrites=2 的令牌扣成 1, 目标文件一个字节没变。
// 下面按**目标行为**断言: 扣不扣次数只看字节有没有变。

/**
 * 令牌路径由 __dirname 上溯三层解析, 所以要把守卫拷进临时树里跑 ——
 * 否则测试会去动真实的 var/audit/protected-write-approvals.json。
 */
function tokenFixture(t, remainingWrites = 2) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'protected-write-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const hooks = path.join(root, 'engine', 'scripts', 'hooks');
  const lib = path.join(root, 'engine', 'scripts', 'lib');
  fs.mkdirSync(hooks, { recursive: true });
  fs.mkdirSync(lib, { recursive: true });
  fs.copyFileSync(GUARD, path.join(hooks, 'file-protection-guard.cjs'));
  for (const dep of [
    'gate-bypass.cjs',
    'project-directory-contract.cjs',
    'project-scope.cjs',
    'harness-root.cjs',
    'risk-policy.cjs',
  ]) {
    fs.copyFileSync(path.join(ROOT, 'engine', 'scripts', 'lib', dep), path.join(lib, dep));
  }

  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# fixture root marker\n', 'utf8');

  const model = path.join(root, 'engineering-assets', 'models', 'comm', 'withconsumer');
  fs.mkdirSync(path.join(model, 'src'), { recursive: true });
  fs.writeFileSync(path.join(model, 'manifest.json'),
    JSON.stringify({ asset_uid: 'model_withconsumer', kind: 'golden-model', implements_for: ['modx'] }), 'utf8');
  const golden = path.join(model, 'src', 'existing.m');
  fs.writeFileSync(golden, '% 既有 golden\n', 'utf8');

  const rtlDir = path.join(root, 'cbb', 'modx', 'rtl');
  fs.mkdirSync(rtlDir, { recursive: true });
  const rtl = path.join(rtlDir, 'modx.sv');
  fs.writeFileSync(rtl, 'module modx; endmodule\n', 'utf8');
  ageRtl(rtl, FOUR_HOURS_MS * 3);                          // 关掉倒置信号

  const approvals = path.join(root, 'var', 'audit', 'protected-write-approvals.json');
  fs.mkdirSync(path.dirname(approvals), { recursive: true });
  fs.writeFileSync(approvals, JSON.stringify([{
    scope: 'engineering-assets/models/comm/withconsumer',
    decision: 'test-ruling-001',
    remainingWrites,
    expiresAt: new Date(Date.now() + FOUR_HOURS_MS).toISOString(),
    reason: '按裁定登记新参考模型',
    basis: { kind: 'user-ruling', ref: 'test ruling', ruling: 'test-ruling-001' },
  }], null, 1), 'utf8');

  return {
    root,
    golden,
    guard: require(path.join(hooks, 'file-protection-guard.cjs')),
    remaining: () => JSON.parse(fs.readFileSync(approvals, 'utf8'))[0]?.remainingWrites ?? 0,
    pendingExists: () => fs.existsSync(path.join(root, 'var', 'audit', 'protected-write-pending.json')),
  };
}

/** 走一遍 PreToolUse: 判定 + commit。返回判定结果。 */
function preToolUse(f) {
  const out = f.guard.evaluate(
    { tool_name: 'Edit', tool_input: { file_path: f.golden } },
    { cwd: f.root, env: {} },
  );
  assert.notEqual(out.decision, 'block', `令牌应放行: ${JSON.stringify(out.diagnostics)}`);
  assert.equal(typeof out.commit, 'function', 'commit 缺失 —— 消费/审计无处发生');
  out.commit();
  return out;
}

test('PreToolUse 放行但写入没发生 → 令牌不得被扣', (t) => {
  const f = tokenFixture(t, 2);
  preToolUse(f);
  assert.equal(f.remaining(), 2, 'commit 阶段就扣次数 = 分类器否决时白烧一张令牌');

  // 分类器否决 / 用户点拒绝: 工具没跑, 文件未变。定向结算应释放而非消费。
  f.guard.settlePendingWrites({ filePath: f.golden });
  assert.equal(f.remaining(), 2, '没写成的写入不该消耗授权次数');
  assert.equal(f.pendingExists(), false, '释放后预留必须清干净, 否则会挂在那里污染下次结算');
});

test('写入真的发生 → 结算时扣一次并入账', (t) => {
  const f = tokenFixture(t, 2);
  preToolUse(f);
  fs.writeFileSync(f.golden, '% 既有 golden\n% 新增一行\n', 'utf8');   // 工具真的写了

  const outcome = f.guard.settlePendingWrites({ filePath: f.golden });
  assert.deepEqual(outcome.settled, [f.golden], '字节变了就必须结算');
  assert.equal(f.remaining(), 1, '真实写入应当且只应当扣一次');
  assert.equal(f.pendingExists(), false);
});

test('重复结算不重复扣次数', (t) => {
  const f = tokenFixture(t, 2);
  preToolUse(f);
  fs.writeFileSync(f.golden, '% 改过了\n', 'utf8');
  f.guard.settlePendingWrites({ filePath: f.golden });
  f.guard.settlePendingWrites({ filePath: f.golden });     // Post 钩子重放 / 兜底清算撞车
  assert.equal(f.remaining(), 1, '结算必须幂等 —— 预留已清则无事可做');
});

test('同一文件连开两次预留 → 只消费一次', (t) => {
  const f = tokenFixture(t, 2);
  preToolUse(f);                                           // 第一次被否决, 预留悬着
  preToolUse(f);                                           // 重试: 旧预留须就地了结
  fs.writeFileSync(f.golden, '% 第二次才写成\n', 'utf8');
  f.guard.settlePendingWrites({ filePath: f.golden });
  assert.equal(f.remaining(), 1, '两条预留压在同一次真实写入上会各扣一次');
});

test('Post 钩子没触发时, 下一次预留兜底清算前一次的真实写入', (t) => {
  const f = tokenFixture(t, 2);
  preToolUse(f);
  fs.writeFileSync(f.golden, '% 写成了但 Post 没跑\n', 'utf8');
  preToolUse(f);                                           // 只靠下一次写入触发清算
  assert.equal(f.remaining(), 1, '兜底清算必须补上漏掉的消费, 否则令牌成了无限开关');
});

test('令牌耗尽后不再放行', (t) => {
  const f = tokenFixture(t, 1);
  preToolUse(f);
  fs.writeFileSync(f.golden, '% 用掉最后一次\n', 'utf8');
  f.guard.settlePendingWrites({ filePath: f.golden });
  assert.equal(f.remaining(), 0, '扣光的令牌应被移除');

  const out = f.guard.evaluate(
    { tool_name: 'Edit', tool_input: { file_path: f.golden } },
    { cwd: f.root, env: {} },
  );
  assert.equal(out.decision, 'block', '次数用尽后必须重新拦下');
});
