#!/usr/bin/env node
/**
 * Hook: sim-governance.cjs
 *
 * PostToolUse hook: 自动清理仿真产物。
 *
 * 功能:
 *   1. Bash 执行仿真命令后自动清理临时文件
 *   2. 自动生成基础 JSON 证据文件
 *
 * 触发条件:
 *   - toolUse.name === 'Bash'
 *   - toolUse.input.command 包含 vsim 或 xsim 或 vlog -sv
 *
 * 执行流程:
 *   1. 检测仿真命令关键字 (vsim/xsim/vlog)
 *   2. 清理 wlft* 临时文件
 *   3. 清理 transcript 文件
 *   4. 清理 *.wlf / vsim.wlf 波形文件
 *   5. 清理 stacktrace 文件
 *   6. 检查 check_results/ 目录，空目录则写入基础 JSON 证据
 *   7. 输出清理报告到 console.error
 *
 * 注册源: settings.json hooks（由 core/engine/scripts/hooks/hook-registry.cjs 校验）
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
// Phase 2.6：仿真治理规则（触发命令/产物清单/证据目录）外置到 fpga pack 规则目录。
// pack 缺席（P-4 可卸性）时降级——shouldTrigger 恒 false，hook 静默不动作。
const { loadPackConfig, compileRegexField } = require('../../scripts/lib/pack-config.cjs');
const RULES = loadPackConfig('sim-governance-rules');
const TRIGGER_COMMAND = compileRegexField(RULES, 'triggerCommand');
const TRIGGER_TOOL = RULES ? String(RULES.toolName || 'Bash') : 'Bash';
const ARTIFACT_TESTS = (RULES && Array.isArray(RULES.artifactFiles) ? RULES.artifactFiles : [])
  .map((spec) => {
    try {
      if (spec.endsWith('^')) return { kind: 'prefix', test: (s) => s.startsWith(spec.slice(0, -1)) };
      return { kind: 'regex', test: (s) => new RegExp(spec).test(s) };
    } catch { return { kind: 'never', test: () => false }; }
  });
const EVIDENCE_DIR = (RULES && RULES.evidenceDir) || 'check_results';
const EVIDENCE_FILE = (RULES && RULES.evidenceFile) || 'governance-evidence.json';

/**
 * 判断是否应该触发清理（规则缺席 → 恒 false，P-4 可卸性降级）。
 * @param {object} toolUse
 * @returns {boolean}
 */
function shouldTrigger(toolUse) {
  if (!TRIGGER_COMMAND) return false;
  if (!toolUse || toolUse.name !== TRIGGER_TOOL) return false;
  const cmd = toolUse.input && toolUse.input.command ? toolUse.input.command : '';
  return TRIGGER_COMMAND.test(cmd);
}

/**
 * 清理指定目录下的仿真产物。
 * @param {string} cwd 工作目录
 * @returns {string[]} 被移除或创建的文件列表
 */
function cleanSimArtifacts(cwd) {
  const filesRemoved = [];

  let entries;
  try {
    entries = fs.readdirSync(cwd);
  } catch (e) {
    // 目录不存在或无权访问，跳过
    return filesRemoved;
  }

  // 1) 规则表驱动的产物清理（前缀 ^ 与正则两种形态；原 wlft*/transcript/*.wlf/
  // stacktrace 四类规则全部收敛进 artifactFiles）。
  for (const entry of entries) {
    for (const t of ARTIFACT_TESTS) {
      if (t.test(entry)) {
        try {
          fs.unlinkSync(path.join(cwd, entry));
          if (!filesRemoved.includes(entry)) filesRemoved.push(entry);
        } catch (e) {
          // 忽略删除失败
        }
        break;
      }
    }
  }

  // 2) 检查证据目录（check_results/），空目录则写入基础 JSON 证据
  const checkResultsPath = path.join(cwd, EVIDENCE_DIR);
  if (fs.existsSync(checkResultsPath)) {
    try {
      const stat = fs.statSync(checkResultsPath);
      if (stat.isDirectory()) {
        const checkEntries = fs.readdirSync(checkResultsPath);
        if (checkEntries.length === 0) {
          const evidence = {
            timestamp: new Date().toISOString(),
            tool: 'sim-governance',
            check: 'empty'
          };
          const evidenceFile = path.join(checkResultsPath, EVIDENCE_FILE);
          fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2), 'utf-8');
          filesRemoved.push(`${EVIDENCE_DIR}/${EVIDENCE_FILE} (created)`);
        }
      }
    } catch (e) {
      // 忽略
    }
  }

  return filesRemoved;
}

/**
 * Hook 主函数。
 * @param {object} context hook 上下文，包含 toolUse 等字段
 */
function simGovernanceHook(context) {
  const toolUse = context && context.toolUse ? context.toolUse : null;
  if (!toolUse || !shouldTrigger(toolUse)) return;

  const cwd = process.cwd();
  const filesRemoved = cleanSimArtifacts(cwd);

  console.error(JSON.stringify({
    source: 'sim-governance',
    type: 'cleanup',
    filesRemoved: filesRemoved,
    message: '清理完成'
  }));
}

// 直接运行时执行
if (require.main === module) {
  simGovernanceHook({ toolUse: { name: 'Bash', input: { command: process.argv.slice(2).join(' ') } } });
}

module.exports = simGovernanceHook;
