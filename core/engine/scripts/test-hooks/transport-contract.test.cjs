'use strict';

/**
 * core/engine/scripts/test-hooks/transport-contract.test.cjs — transport 归一化层契约测试
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

const transportRoot = path.join(HARNESS_ROOT, 'core', 'engine', 'scripts', 'transport');
const {
  normalize,
  TRANSPORTS,
  resolveTransport,
  ingest,
  toCanonicalPayload,
} = require(path.join(transportRoot, 'index.cjs'));

const FIXTURES_ROOT = path.join(HARNESS_ROOT, 'core', 'engine', 'scripts', 'test-hooks', 'fixtures');
const FIXTURE_DIRS = ['transport-claude-code', 'transport-workbuddy', 'transport-codex'];

const SCHEMA_PATH = path.join(HARNESS_ROOT, 'core', 'engine', 'schemas', 'harness-event-v1.schema.json');
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
    } else if (value !== null && typeof value === 'object') {
      // 对象型期望（如 toolInput）按值比较：assert.equal 是引用比较，对 fixture 无意义。
      assert.deepEqual(actual[key], value,
        `${key} expected ${JSON.stringify(value)}, got ${JSON.stringify(actual[key])}`);
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

// ── M3 边界入口：resolveTransport / ingest / toCanonicalPayload ────────────

function fixtureById(dir, id) {
  const found = loadFixtures(dir).find((entry) => entry.id === id);
  assert.ok(found, `fixture '${id}' missing in ${dir}`);
  return found;
}

// resolveTransport 优先级：explicit > argv > env > 默认
assert.equal(
  resolveTransport({ explicit: 'codex', argv: ['node', 'x', '--transport', 'workbuddy'], env: { HARNESS_TRANSPORT: 'claude-code' } }),
  'codex', 'explicit 必须压过 argv 与 env');
assert.equal(
  resolveTransport({ argv: ['node', 'x', '--transport', 'workbuddy'], env: { HARNESS_TRANSPORT: 'codex' } }),
  'workbuddy', 'argv 必须压过 env');
assert.equal(
  resolveTransport({ argv: ['node', 'x', '--transport=workbuddy'], env: {} }),
  'workbuddy', '--transport=<name> 形式必须被识别');
assert.equal(resolveTransport({ argv: ['node', 'x'], env: { HARNESS_TRANSPORT: 'codex' } }), 'codex', 'env 次之');
assert.equal(resolveTransport({ argv: ['node', 'x'], env: {} }), 'claude-code', '缺省必须是 claude-code');
assertThrowsEventInvalid(
  () => resolveTransport({ explicit: 'gemini', argv: ['node', 'x'], env: {} }), 'resolveTransport 非法显式名');
assertThrowsEventInvalid(
  () => resolveTransport({ argv: ['node', 'x', '--transport', 'gemini'], env: {} }), 'resolveTransport 非法 argv 名');
assertThrowsEventInvalid(
  () => resolveTransport({ argv: ['node', 'x'], env: { HARNESS_TRANSPORT: 'gemini' } }), 'resolveTransport 非法 env 名');

// ingest：claude-code 下规范载荷是 raw 本身（同一引用，恒等 ⇒ 门禁读取零变化）
const claudePair = fixtureById('transport-claude-code', 'claude-pre-tool-use-write-snake');
const claudeIngested = ingest(claudePair.input, { argv: ['node', 'preflight-router.cjs'], env: {} });
assert.equal(claudeIngested.transport, 'claude-code', 'claude 默认 transport');
assert.equal(claudeIngested.payload, claudePair.input, 'claude-code 的规范载荷必须是 raw 同一引用');
assert.equal(claudeIngested.error, null, 'claude 合法载荷不得带 error');
assert.equal(claudeIngested.event.toolName, 'Write', 'ingest 必须返回 normalize() 事件');

// ingest：workbuddy camelCase 载荷 → 规范载荷与 Claude snake_case 等价用例一致
const workbuddyPair = fixtureById('transport-workbuddy', 'workbuddy-pre-tool-use-write-camel');
const workbuddyIngested = ingest(workbuddyPair.input, { transport: 'workbuddy' });
assert.equal(workbuddyIngested.transport, 'workbuddy');
for (const key of ['hook_event_name', 'tool_name', 'session_id', 'cwd', 'tool_use_id']) {
  assert.equal(workbuddyIngested.payload[key], claudePair.input[key],
    `规范载荷 ${key} 必须与 Claude 等价用例一致`);
}
assert.deepEqual(workbuddyIngested.payload.tool_input, claudePair.input.tool_input,
  '规范载荷 tool_input 必须与 Claude 等价用例一致');
assert.deepEqual(
  toCanonicalPayload(workbuddyIngested.event, workbuddyPair.input),
  toCanonicalPayload(claudeIngested.event, claudePair.input),
  'camelCase 与 snake_case 两侧的规范载荷必须逐字段一致');

// ingest：归一化失败绝不抛，回 fallback 事件 + error（形状同 progress-watchdog fallback）
for (const [badRaw, label] of [['not-an-object', '字符串载荷'], [[1, 2, 3], '数组载荷'], [null, 'null 载荷']]) {
  const failed = ingest(badRaw, { transport: 'workbuddy' });
  assert.ok(failed.error, `${label} 必须带 error`);
  assert.equal(failed.error.code, 'EVENT_INVALID', `${label} 的 error 必须是 EVENT_INVALID`);
  assert.equal(failed.event.eventId, 'fallback', `${label} 必须回 fallback 事件`);
  assert.equal(failed.event.status, 'unknown', `${label} fallback 必须 status=unknown`);
  assert.equal(failed.event.eventType, 'unknown');
  assert.equal(failed.event.transport, 'workbuddy');
  assert.equal(failed.event.source.adapter, 'fallback');
  assert.equal(failed.event.source.statusInferred, true);
  assert.equal(failed.event.source.payloadHash, null);
  assertConformsToSchema(failed.event);
}
// 非法 transport 名同样不抛，降级为 claude-code + error
const badTransport = ingest({ hook_event_name: 'PreToolUse' }, { transport: 'gemini' });
assert.equal(badTransport.error?.code, 'EVENT_INVALID', '非法 transport 必须记录 error 而不是抛出');
assert.equal(badTransport.transport, 'claude-code', '非法 transport 降级为默认 transport');
assert.equal(badTransport.event.eventId, 'fallback');

// extensions：extras（toolResponse / prompt / transcriptPath / trigger / stopHookActive / error）
const extrasRaw = {
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_response: { stdout: 'ok' },
  prompt: 'run the tests',
  transcript_path: 'C:/work/project/.transcript.jsonl',
  trigger: 'manual',
  stop_hook_active: true,
  error: 'boom',
  session_id: 'extras-001',
  cwd: 'C:/work/project',
};
const extrasEvent = normalize(extrasRaw, 'claude-code');
assertConformsToSchema(extrasEvent);
assert.deepEqual(extrasEvent.extensions, {
  toolResponse: { stdout: 'ok' },
  prompt: 'run the tests',
  transcriptPath: 'C:/work/project/.transcript.jsonl',
  trigger: 'manual',
  stopHookActive: true,
  error: 'boom',
}, 'claude 适配器必须把 extras 以 camelCase 写进 extensions');

const extrasCamelRaw = {
  hookEventName: 'PostToolUse',
  toolName: 'Bash',
  toolResponse: { stdout: 'ok' },
  transcriptPath: 'C:/work/project/.transcript.jsonl',
  stopHookActive: false,
  sessionId: 'extras-002',
};
assert.deepEqual(normalize(extrasCamelRaw, 'workbuddy').extensions, {
  toolResponse: { stdout: 'ok' },
  transcriptPath: 'C:/work/project/.transcript.jsonl',
  stopHookActive: false,
}, 'workbuddy 适配器必须接受 camelCase extras 并归一到 camelCase extensions');

assert.deepEqual(normalize({ eventType: 'tool.post', status: 'failed', result: { code: 1 } }, 'codex').extensions,
  { toolResponse: { code: 1 } }, 'codex 适配器必须把 result 归一为 extensions.toolResponse');
assert.deepEqual(normalize({ eventType: 'session.start' }, 'codex').extensions, {},
  '无 extras 时 extensions 必须为空对象');

// toCanonicalPayload：未映射键原样保留 + codex 事件名逆向反推
const passthroughRaw = {
  hookEventName: 'PostToolUse',
  toolName: 'Bash',
  toolInput: { command: 'node --test' },
  sessionId: 'pass-001',
  cwd: 'C:/work/project',
  tool_response: { stdout: 'ok' },
  status: 'success',
  vendorSpecificField: { keep: 'me' },
  anotherUnmappedKey: 42,
};
const passthrough = toCanonicalPayload(normalize(passthroughRaw, 'workbuddy'), passthroughRaw);
assert.deepEqual(passthrough.vendorSpecificField, { keep: 'me' }, '未映射键必须原样保留');
assert.equal(passthrough.anotherUnmappedKey, 42, '未映射键必须原样保留');
assert.equal(passthrough.hook_event_name, 'PostToolUse');
assert.equal(passthrough.tool_name, 'Bash');
assert.deepEqual(passthrough.tool_input, { command: 'node --test' });
assert.deepEqual(passthrough.tool_response, { stdout: 'ok' });
assert.equal(passthrough.status, 'succeeded', 'status 取自 event.status（显式证据 success → succeeded）');
assert.ok(!('hookEventName' in passthrough), '已映射的 camel 别名不得重复出现在规范载荷');
assert.ok(!('toolInput' in passthrough), '已映射的 camel 别名不得重复出现在规范载荷');

const codexCases = [
  [{ eventType: 'tool.pre', toolName: 'Edit' }, 'PreToolUse'],
  [{ eventType: 'tool.post', status: 'succeeded' }, 'PostToolUse'],
  [{ eventType: 'tool.post', status: 'failed' }, 'PostToolUseFailure'],
  [{ eventType: 'session.start' }, 'SessionStart'],
  [{ eventType: 'session.stop' }, 'Stop'],
  [{ eventType: 'subagent.stop' }, 'SubagentStop'],
  [{ eventType: 'session.precompact' }, 'PreCompact'],
  [{ eventType: 'prompt.submit', prompt: 'hi' }, 'UserPromptSubmit'],
];
for (const [options, expectedNative] of codexCases) {
  const { payload } = ingest(options, { transport: 'codex' });
  assert.equal(payload.hook_event_name, expectedNative,
    `codex ${options.eventType}/${options.status || 'unknown'} 必须反推为 ${expectedNative}`);
  assert.equal(payload.status, options.status || 'unknown', 'codex 规范载荷 status 取自 event.status');
}

process.stdout.write(`TRANSPORT_CONTRACT_RESULT: PASS (${caseCount} fixtures + fail-closed + ingest/render 边界)\n`);
