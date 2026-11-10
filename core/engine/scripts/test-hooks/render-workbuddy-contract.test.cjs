#!/usr/bin/env node
'use strict';

/**
 * core/engine/scripts/test-hooks/render-workbuddy-contract.test.cjs — WorkBuddy 渲染目标契约
 *
 * 验证 Task #7 的多目标渲染器：
 *   1. core/engine/hooks/workbuddy.hooks.json 必须存在（由 render-hook-settings.cjs 从
 *      hosts/claude-code/registrations.json 渲染，CI 已先行执行渲染步骤）；
 *   2. 与单一契约源 registrations.json 的渲染结果一致（--check 语义，无漂移）；
 *   3. 渲染产物不得残留 {{HARNESS_ROOT}} 占位符（绝对路径已展开）；
 *   4. WorkBuddy 目标的 hooks 块与 Claude 目标同构（事件名集合一致）——这是
 *      transport 归一化层（core/engine/scripts/transport/）可复用的前提；
 *   5. WorkBuddy 渲染结果仍能让 manifest 的 active 条目全部有据可依
 *      （validateHookManifest 用该 hooks 块校验无错误）。
 *
 * 独立可执行：退出码 0 = 通过（由 run-all-tests.cjs 的 AuditRemediationContracts spawn 校验）。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Phase 1.1/1.3 起布局：core/engine/scripts/test-hooks 上溯 4 级 = 仓库根；
// 模板真源在 hosts/claude-code/，渲染产物在 core/engine/hooks/。
const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const RENDERER = path.join(ROOT, 'core', 'engine', 'scripts', 'render-hook-settings.cjs');
const REGISTRATIONS = path.join(ROOT, 'hosts', 'claude-code', 'registrations.json');
const WORKBUDDY_HOOKS = path.join(ROOT, 'core', 'engine', 'hooks', 'workbuddy.hooks.json');
const { renderHooks, renderWorkbuddyHooks } = require(RENDERER);
const { validateHookManifest } = require(path.join(ROOT, 'core', 'engine', 'scripts', 'lib', 'hook-registry.cjs'));

function main() {
  // 1. 目标文件必须存在（CI 渲染步骤先行）
  assert.ok(fs.existsSync(WORKBUDDY_HOOKS), 'core/engine/hooks/workbuddy.hooks.json is missing (run render-hook-settings.cjs)');

  // 2. 与单一契约源渲染结果一致（canonical 比对，避免键序噪声）
  const canonical = (value) => JSON.stringify(value, Object.keys(value).sort());
  const renderedTarget = JSON.parse(fs.readFileSync(WORKBUDDY_HOOKS, 'utf8'));
  assert.equal(canonical(renderedTarget), canonical(renderWorkbuddyHooks({ root: ROOT })),
    'workbuddy.hooks.json drifted from registrations.json template');

  // 3. 占位符必须已展开为绝对路径（与 settings.json 同理：$HOME 会使 hook 静默不触发），
  //    且不得残留未展开占位符
  const raw = fs.readFileSync(WORKBUDDY_HOOKS, 'utf8');
  assert.doesNotMatch(raw, /\{\{[A-Z_]+\}\}/, 'workbuddy.hooks.json still contains unexpanded placeholders');
  assert.match(raw, /node [A-Za-z]:[\\/]/, 'workbuddy.hooks.json must expand {{HARNESS_ROOT}} to an absolute path');

  // 4. 与 Claude 目标事件名集合一致（hooks 块同构）
  const claudeHooks = renderHooks({ root: ROOT });
  const workbuddyHooks = renderedTarget.hooks;
  assert.deepEqual(Object.keys(workbuddyHooks).sort(), Object.keys(claudeHooks).sort(),
    'workbuddy and claude render targets must expose the same hook event set');
  const eventCount = Object.keys(workbuddyHooks).length;
  assert.ok(eventCount >= 7, `workbuddy target exposes only ${eventCount} events`);

  // 4b. WorkBuddy 目标每条命令末尾带 `--transport workbuddy`（M3 传输层标注）；
  //     Claude 目标不追加 —— 默认即 claude-code，追加只会让本机注册漂移。
  const commandsOf = (hooksBlock) => Object.values(hooksBlock)
    .flatMap((groups) => (Array.isArray(groups) ? groups : []))
    .flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : [group]))
    .map((hook) => String(hook?.command || ''))
    .filter(Boolean);
  const workbuddyCommands = commandsOf(workbuddyHooks);
  assert.ok(workbuddyCommands.length > 0, 'workbuddy target renders no commands');
  for (const command of workbuddyCommands) {
    assert.ok(command.endsWith(' --transport workbuddy'),
      `workbuddy command must carry the transport flag: ${command}`);
  }
  for (const command of commandsOf(claudeHooks)) {
    assert.doesNotMatch(command, /--transport\b/,
      `claude settings.json command must stay transport-free: ${command}`);
  }

  // 5. manifest 的 active 条目在 WorkBuddy 目标上全部有据可依
  const validated = validateHookManifest({ root: ROOT, config: { hooks: workbuddyHooks } });
  assert.deepEqual(validated.errors, [], `manifest disagrees with workbuddy render: ${validated.errors.join('; ')}`);
  assert.ok(validated.checked > 0, 'workbuddy render registers no hooks at all');

  // 6. registrations.json 单一契约源保持可移植（不得写死绝对路径）
  const templateText = fs.readFileSync(REGISTRATIONS, 'utf8');
  assert.match(templateText, /\{\{HARNESS_ROOT\}\}/, 'template must keep the portable placeholder');
  assert.doesNotMatch(templateText, /[A-Za-z]:[\\/]Users[\\/]/, 'template leaks a machine-local path');

  process.stdout.write('RENDER_WORKBUDDY_CONTRACT_RESULT: PASS\n');
}

main();
