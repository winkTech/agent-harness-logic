'use strict';

/**
 * failure-signature-contract — 失败指纹的行为契约。
 *
 * 这里锁死的是"什么算同一个失败"。判据一旦漂移, 依赖它的三处 (DAG 循环门禁、
 * frustration-detector、loop-controller) 会同时失准, 而失准的方向是**沉默的**:
 * 指纹过松会把不同失败并成一个坑, 过紧则永远不触发"换方法"。
 */

const assert = require('node:assert/strict');
const {
  normalize, family, signature, similar, strategyHint,
} = require('../lib/failure-signature.cjs');

// ── 1. 噪声必须被抹平: 同一失败换个位置/耗时仍是同一指纹 ─────────────────────

function assertNoiseInvariance() {
  const a = signature('Error: ENOENT: no such file or directory, open '
    + "'C:\\Users\\Lihan\\proj\\rtl\\top.sv' at top.js:120:15 (took 1350ms)");
  const b = signature('Error: ENOENT: no such file or directory, open '
    + "'D:\\other\\place\\rtl\\top.sv' at top.js:998:3 (took 12ms)");
  assert.equal(a.fingerprint, b.fingerprint, '路径/行号/耗时不同不应产生新指纹');
  assert.equal(a.family, 'not_found');

  const posixA = signature('cannot open /home/u/work/a/b/leaf.sv line 42');
  const posixB = signature('cannot open /var/tmp/zzz/leaf.sv line 7');
  assert.equal(posixA.fingerprint, posixB.fingerprint, 'POSIX 路径同样要归一化');

  const tsA = signature('[2026-08-01T10:00:00.123Z] worker pid 4242 failed 0x7ffd1234');
  const tsB = signature('[2026-07-30T22:13:01.900Z] worker pid 91 failed 0xdeadbeef');
  assert.equal(tsA.fingerprint, tsB.fingerprint, '时间戳/PID/地址必须抹平');
}

// ── 2. 语义数字必须保留: 不同退出码不是同一个失败 ────────────────────────────

function assertSemanticDigitsKept() {
  const one = signature('command failed with exit code 1');
  const other = signature('command failed with exit code 127');
  assert.notEqual(one.fingerprint, other.fingerprint, 'exit code 是语义信息, 不能被抹平');
  assert.equal(one.family, 'nonzero_exit');

  const expA = signature('AssertionError: expected 8 but got 3');
  const expB = signature('AssertionError: expected 8 but got 5');
  assert.notEqual(expA.fingerprint, expB.fingerprint, '断言期望/实际值不同应视为不同失败');
  assert.equal(expA.family, 'assertion');
}

// ── 3. 族判定 ────────────────────────────────────────────────────────────────

function assertFamilies() {
  const cases = [
    ['[DAG] node timeout (300000ms)', 'timeout'],
    ['EACCES: permission denied, open config', 'permission'],
    ['connect ECONNREFUSED 127.0.0.1:8080', 'network'],
    ['SyntaxError: Unexpected token }', 'syntax'],
    ['TypeError: x.map is not a function', 'type'],
    ['ENOMEM: out of memory', 'resource'],
    ['operation was aborted by the user', 'cancelled'],
    ['something entirely unclassifiable happened', 'unknown'],
  ];
  for (const [text, expected] of cases) {
    assert.equal(family(normalize(text)), expected, `族判定错误: ${text}`);
  }
}

// ── 4. 工具维度参与分组 ──────────────────────────────────────────────────────

function assertToolScoping() {
  const bash = signature('timed out after 30s', { tool: 'Bash' });
  const edit = signature('timed out after 30s', { tool: 'Edit' });
  assert.notEqual(bash.fingerprint, edit.fingerprint, '不同工具的同类失败不是同一个坑');

  const nodeA = signature('failed', { scope: 'node-a' });
  const nodeB = signature('failed', { scope: 'node-b' });
  assert.notEqual(nodeA.fingerprint, nodeB.fingerprint, 'scope 应参与分组');
}

// ── 5. similar 的宽严边界 ────────────────────────────────────────────────────

function assertSimilarity() {
  const a = signature('ENOENT: no such file or directory, open a.sv');
  const b = signature('ENOENT: no such file or directory, open a.sv');
  assert.equal(similar(a, b), true, '同指纹必然相似');

  const c = signature('SyntaxError: Unexpected token }');
  assert.equal(similar(a, c), false, '跨族不得判为相似');

  assert.equal(similar('', ''), false, '空错误不得判为相似 (否则"没有错误"会触发循环门禁)');
  assert.equal(signature('').empty, true);
  assert.equal(signature(null).empty, true);
}

// ── 6. 非字符串输入 ──────────────────────────────────────────────────────────

function assertInputShapes() {
  const fromError = signature(new Error('ENOENT: no such file'));
  assert.equal(fromError.family, 'not_found');

  const fromObject = signature({ stderr: 'EACCES: permission denied' });
  assert.equal(fromObject.family, 'permission');

  const fromRunResult = signature({ message: '', stderr: 'connect ETIMEDOUT' });
  assert.equal(fromRunResult.family, 'timeout');
}

// ── 7. 策略建议覆盖每个族 ────────────────────────────────────────────────────

function assertStrategyHints() {
  const families = new Set(['unknown']);
  for (const [name] of require('../lib/failure-signature.cjs').FAMILIES) families.add(name);
  for (const name of families) {
    const hint = strategyHint(name, 2);
    assert.ok(hint && hint.length > 10, `族 ${name} 缺少可用的策略建议`);
    assert.match(hint, /2 次/, '建议里必须带上重复次数');
  }
}

function main() {
  assertNoiseInvariance();
  assertSemanticDigitsKept();
  assertFamilies();
  assertToolScoping();
  assertSimilarity();
  assertInputShapes();
  assertStrategyHints();
  process.stdout.write('FAILURE_SIGNATURE_RESULT: PASS\n');
}

main();
