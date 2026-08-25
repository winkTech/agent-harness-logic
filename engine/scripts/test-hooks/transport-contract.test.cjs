'use strict';

/**
 * engine/scripts/test-hooks/transport-contract.test.cjs — transport 归一化层契约测试
 *
 * 验证 harness-event-v1 契约（S1 基础画像）在三 transport（claude-code /
 * workbuddy / codex）上的一致性：
 *   1. 归一化输出满足 schema 的 required 字段与枚举约束（eventType/transport/status）；
 *   2. 输出无 schema 之外的额外键（additionalProperties: false 的轻量等价断言）；
 *   3. 每个 fixture 的预期字段（含 source 子集）与实际输出一致；
 *   4. D1 真实事件语义：缺 status 一律 unknown，不臆测成功/失败；
 *   5. fail-closed：非法载荷与未知 transport 抛 EVENT_INVALID。
 *
 * 独立可执行：退出码 0 = 通过；失败打印堆栈并以 exit 1 结束
 * （由 run-all-tests.cjs 的 AuditRemediationContracts 组 spawn 校验）。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { HARNESS_ROOT } = require('../lib/harness-root.cjs');

const transportRoot = path.join(HARNESS_ROOT, 'engine', 'scripts', 'transport');
const { normalize, TRANSPORTS } = require(path.join(transportRoot, 'index.cjs'));

const FIXTURES_ROOT = path.join(HARNESS_ROOT, 'engine', 'scripts', 'test-hooks', 'fixtures');
const FIXTURE_DIRS = ['transport-claude-code', 'transport-workbuddy', 'transport-codex'];

const SCHEMA_PATH = path.join(HARNESS_ROOT, 'engine', 'schemas', 'harness-event-v1.schema.json');
const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));

const ALLOWED_EVENT_TYPES = new Set(schema.properties.eventType.enum);
const ALLOWED_TRANSPORTS = new Set(schema.properties.transport.enum);
const ALLOWED_STATUS = new Set(schema.properties.status.enum);
const SCHEMA_KEYS = new Set(Object.keys(schema.properties));
const SCHEMA_SOURCE_KEYS = new Set(Object.keys(schema.properties.source.properties));

function assertConformsToSchema(event) {
  for (const required of schema.required) {
    assert.ok(required in event, `missing required field '${required}' in normalized event`);
  }
  for (const key of Object.keys(event)) {
    assert.ok(SCHEMA_KEYS.has(key), `extra field '${key}' violates additionalProperties: false`);
  }
  assert.ok(ALLOWED_EVENT_TYPES.has(event.eventType), `eventType '${event.eventType}' not in schema enum`);
  assert.ok(ALLOWED_TRANSPORTS.has(event.transport), `transport '${event.transport}' not in schema enum`);
  assert.ok(ALLOWED_STATUS.has(event.status), `status '${event.status}' not in schema enum`);
  if (event.source) {
    for (const key of Object.keys(event.source)) {
      assert.ok(SCHEMA_SOURCE_KEYS.has(key), `extra source field '${key}' violates source schema`);
    }
  }
}

function assertMatchesExpected(actual, expected) {
  for (const [key, value] of Object.entries(expected)) {
    if (key === 'source') {
      for (const [sourceKey, sourceValue] of Object.entries(value)) {
        assert.equal(actual.source?.[sourceKey], sourceValue,
          `source.${sourceKey} expected ${JSON.stringify(sourceValue)}, got ${JSON.stringify(actual.source?.[sourceKey])}`);
      }
    } else {
      assert.equal(actual[key], value, `${key} expected ${JSON.stringify(value)}, got ${JSON.stringify(actual[key])}`);
    }
  }
}

function loadFixtures(dir) {
  const file = path.join(FIXTURES_ROOT, dir, 'cases.json');
  assert.ok(fs.existsSync(file), `fixture missing: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ── 用例执行 ───────────────────────────────────────────────────────────────

let caseCount = 0;
for (const dir of FIXTURE_DIRS) {
  for (const fixture of loadFixtures(dir)) {
    caseCount += 1;
    const actual = normalize(fixture.input, fixture.transport);
    assertConformsToSchema(actual);
    assertMatchesExpected(actual, fixture.expected);

    // D1 补强断言：缺 status 的用例必须归一为 unknown，且 source 标记 statusInferred
    const inputStatus = fixture.input.status ?? fixture.input.result?.status;
    const inputSuccess = typeof fixture.input.success === 'boolean' ? fixture.input.success : undefined;
    const hasExplicitEvidence = inputStatus !== undefined || inputSuccess !== undefined
      || fixture.input.hook_event_name === 'PostToolUseFailure'
      || fixture.input.hookEventName === 'PostToolUseFailure';
    if (!hasExplicitEvidence) {
      assert.equal(actual.status, 'unknown',
        `D1 violation: ${fixture.id} has no explicit result evidence but normalized to '${actual.status}'`);
      assert.equal(actual.source.statusInferred, true,
        `D1 violation: ${fixture.id} must mark statusInferred=true when status was inferred`);
    }
  }
}

// ── fail-closed 用例 ───────────────────────────────────────────────────────

function assertThrowsEventInvalid(fn, label) {
  let threw = false;
  try {
    fn();
  } catch (error) {
    threw = true;
    assert.equal(error.code, 'EVENT_INVALID', `${label} must throw EVENT_INVALID, got ${error.code}`);
  }
  assert.ok(threw, `${label} must throw (fail-closed)`);
}

assertThrowsEventInvalid(() => normalize('not-an-object', 'claude-code'), 'claude-code 非法载荷');
assertThrowsEventInvalid(() => normalize([1, 2, 3], 'claude-code'), 'claude-code 数组载荷');
assertThrowsEventInvalid(() => normalize('not-an-object', 'workbuddy'), 'workbuddy 非法载荷');
assertThrowsEventInvalid(() => normalize(null, 'codex'), 'codex null 载荷');
assertThrowsEventInvalid(() => normalize({ eventType: 'not-an-event' }, 'codex'), 'codex 未知 eventType');
assertThrowsEventInvalid(() => normalize({ eventType: 'tool.post', status: 'maybe' }, 'codex'), 'codex 非法 status');
assertThrowsEventInvalid(() => normalize({}, 'gemini'), '未知 transport');

// ── transport 枚举与 schema 一致 ───────────────────────────────────────────

assert.deepEqual([...TRANSPORTS].sort(), [...ALLOWED_TRANSPORTS].sort(),
  'index.cjs TRANSPORTS 必须与 schema transport 枚举一致');

process.stdout.write(`TRANSPORT_CONTRACT_RESULT: PASS (${caseCount} fixtures + fail-closed)\n`);
