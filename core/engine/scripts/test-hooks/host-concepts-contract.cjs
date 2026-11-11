#!/usr/bin/env node
'use strict';

/**
 * core/engine/scripts/test-hooks/host-concepts-contract.cjs — 方言表合同测试
 *
 * Phase 2.1 验收条款：方言表单测（三宿主事件翻译往返一致）通过。
 * 覆盖：
 *   1. ACTIONS 词表与 §3.7 八动作一致
 *   2. CONTROLLED_TOOLS 与原三副本逐字一致（防漂移回归）
 *   3. 三宿主事件翻译往返一致（native → action → native）
 *   4. 能力谓词完备性（每个 CONTROLLED 工具至少一谓词；write/shell 互斥）
 *   5. matcher 展开（toolsFromMatcher / sessionStartSourcesFromMatcher）
 *   6. 冻结性（词表不可变——运行期篡改应静默失败或抛错）
 */

const assert = require('node:assert/strict');
const hc = require('../lib/host-concepts.cjs');

let passed = 0;
let failed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('ACTIONS 词表 = §3.7 八动作', () => {
  assert.deepEqual([...hc.ACTIONS], [
    'before_tool', 'after_tool', 'after_tool_failure', 'prompt_submit',
    'session_start', 'turn_end', 'pre_compact', 'subagent_end',
  ]);
});

test('CONTROLLED_TOOLS 与原三副本逐字一致', () => {
  assert.deepEqual([...hc.CONTROLLED_TOOLS].sort(),
    ['Bash', 'Edit', 'Write', 'MultiEdit', 'Agent', 'Task', 'Workflow'].sort());
  assert.equal(hc.isControlledTool('Bash'), true);
  assert.equal(hc.isControlledTool('PowerShell'), false);
  assert.equal(hc.isControlledTool('NotebookEdit'), false);
});

test('READ_ONLY / DIRECT_PROGRESS / LONG_TASK / NOTIFY 与 watchdog 原表一致', () => {
  assert.deepEqual([...hc.READ_ONLY_TOOLS].sort(),
    ['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'TodoRead', 'AskUserQuestion'].sort());
  assert.deepEqual([...hc.DIRECT_PROGRESS_TOOLS].sort(),
    ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Agent', 'Workflow'].sort());
  assert.deepEqual([...hc.LONG_TASK_TOOLS].sort(), ['Agent', 'Task', 'Workflow'].sort());
  assert.deepEqual([...hc.NOTIFY_TOOL_NAMES].sort(),
    ['AskUserQuestion', 'PushNotification', 'SendMessage', 'TodoWrite', 'ToolSearch'].sort());
});

test('三宿主事件翻译往返一致（native→action→native）', () => {
  for (const host of ['claude-code', 'workbuddy']) {
    const dialect = hc.HOST_DIALECTS[host];
    for (const [native, action] of Object.entries(dialect.events)) {
      assert.equal(hc.actionForNativeEvent(native, host), action,
        `${host}: ${native} → ${action}`);
      // 往返：action 反查 native（构建逆向映射验证无碰撞）
      const reverse = Object.entries(dialect.events).filter(([, a]) => a === action).map(([n]) => n);
      assert.equal(reverse.length, 1, `${host}: action ${action} 有多个 native 映射（歧义）`);
      assert.equal(reverse[0], native);
    }
  }
});

test('workbuddy 与 claude-code 事件方言同构（M3 契约）', () => {
  const cc = hc.HOST_DIALECTS['claude-code'].events;
  const wb = hc.HOST_DIALECTS.workbuddy.events;
  assert.deepEqual(Object.keys(cc).sort(), Object.keys(wb).sort());
  for (const k of Object.keys(cc)) assert.equal(cc[k], wb[k], `事件 ${k} 两宿主持平`);
});

test('codex eventType→action 覆盖 before_tool/after_tool', () => {
  const m = hc.HOST_DIALECTS.codex.eventTypeToAction;
  assert.equal(m['tool.pre'], 'before_tool');
  assert.equal(m['tool.post'], 'after_tool');
});

test('能力谓词：每个 CONTROLLED 工具至少一谓词', () => {
  for (const tool of hc.CONTROLLED_TOOLS) {
    const caps = hc.TOOL_CAPABILITY.get(tool);
    assert.ok(caps && caps.length >= 1, `${tool} 无能力谓词`);
  }
});

test('能力谓词：write/shell 互斥（无工具同时具备）', () => {
  for (const [tool, caps] of hc.TOOL_CAPABILITY) {
    const hasWrite = caps.includes('write');
    const hasShell = caps.includes('shell');
    assert.ok(!(hasWrite && hasShell), `${tool} 同时具备 write+shell（谓词冲突）`);
  }
});

test('toolsFromMatcher 展开 + 别名翻译', () => {
  assert.deepEqual(hc.toolsFromMatcher('Edit|Write|MultiEdit|Bash|PowerShell|Skill'),
    ['Edit', 'Write', 'MultiEdit', 'Bash', 'PowerShell', 'Skill']);
  assert.deepEqual(hc.toolsFromMatcher('*'), []);
  assert.deepEqual(hc.toolsFromMatcher('Execute|Edit', 'workbuddy'), ['Bash', 'Edit']);
});

test('sessionStartSourcesFromMatcher 枚举展开', () => {
  assert.deepEqual(hc.sessionStartSourcesFromMatcher('startup|resume|clear|compact|fork'),
    ['startup', 'resume', 'clear', 'compact', 'fork']);
  assert.deepEqual(hc.sessionStartSourcesFromMatcher(''), []);
});

test('词表冻结（运行期篡改无效）', () => {
  'use strict';
  assert.throws(() => { hc.ACTIONS.push('tamper'); }, TypeError);
  assert.throws(() => { hc.CONTROLLED_TOOLS.push('Tamper'); }, TypeError);
  // 判定函数读模块私有 Set——导出的冻结数组被篡改也不影响判定。
  assert.equal(hc.isControlledTool('Tamper'), false);
  assert.equal(hc.isControlledTool('Bash'), true);
});

test('未知宿主/事件 fail-soft（null / 透传）', () => {
  assert.equal(hc.actionForNativeEvent('PreToolUse', 'unknown-host'), null);
  assert.equal(hc.actionForNativeEvent('NotExist'), null);
  assert.equal(hc.canonicalToolName('Anything', 'claude-code'), 'Anything');
});

for (const t of tests) {
  process.stdout.write(`  ${t.name.padEnd(58)} `);
  try { t.fn(); passed += 1; console.log('PASS'); }
  catch (e) { failed += 1; console.log(`FAIL\n    ${e.message}`); }
}
console.log(`\nSummary: ${passed}/${tests.length} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
