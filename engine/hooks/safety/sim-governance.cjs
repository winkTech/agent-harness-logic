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
 * 注册 (hook-config.json):
 *   "safety/sim-governance.cjs": { enabled: true, frequency: "medium", ... }
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * 判断是否应该触发清理。
 * @param {object} toolUse
 * @returns {boolean}
 */
function shouldTrigger(toolUse) {
  if (!toolUse || toolUse.name !== 'Bash') return false;
  const cmd = toolUse.input && toolUse.input.command ? toolUse.input.command : '';
  return /\bvsim\b/.test(cmd) || /\bxsim\b/.test(cmd) || /\bvlog\s+-sv\b/.test(cmd);
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

  // 1) 清理 wlft* 文件（ModelSim/Questa 临时文件）
  for (const entry of entries) {
    if (/^wlft/.test(entry)) {
      try {
        fs.unlinkSync(path.join(cwd, entry));
        filesRemoved.push(entry);
      } catch (e) {
        // 忽略删除失败
      }
    }
  }

  // 2) 清理 transcript 文件
  if (entries.includes('transcript')) {
    try {
      fs.unlinkSync(path.join(cwd, 'transcript'));
      filesRemoved.push('transcript');
    } catch (e) {
      // 忽略
    }
  }

  // 3) 清理 *.wlf 波形文件 (含 vsim.wlf)
  for (const entry of entries) {
    if (/\.wlf$/i.test(entry)) {
      try {
        fs.unlinkSync(path.join(cwd, entry));
        if (!filesRemoved.includes(entry)) {
          filesRemoved.push(entry);
        }
      } catch (e) {
        // 忽略
      }
    }
  }

  // 4) 清理 stacktrace 文件
  const stackFiles = ['vish_stacktrace.vstf', 'vsim_stacktrace.vstf'];
  for (const sf of stackFiles) {
    if (entries.includes(sf)) {
      try {
        fs.unlinkSync(path.join(cwd, sf));
        filesRemoved.push(sf);
      } catch (e) {
        // 忽略
      }
    }
  }

  // 5) 检查 check_results/ 目录
  const checkResultsPath = path.join(cwd, 'check_results');
  if (fs.existsSync(checkResultsPath)) {
    try {
      const stat = fs.statSync(checkResultsPath);
      if (stat.isDirectory()) {
        const checkEntries = fs.readdirSync(checkResultsPath);
        if (checkEntries.length === 0) {
          // 空目录 → 写入基础 JSON 证据文件
          const evidence = {
            timestamp: new Date().toISOString(),
            tool: 'sim-governance',
            check: 'empty'
          };
          const evidenceFile = path.join(checkResultsPath, 'governance-evidence.json');
          fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2), 'utf-8');
          filesRemoved.push('check_results/governance-evidence.json (created)');
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
