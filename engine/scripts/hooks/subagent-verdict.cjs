#!/usr/bin/env node
'use strict';

/**
 * engine/scripts/hooks/subagent-verdict.cjs — SubagentStop 判定回灌。
 *
 * 并行编排 (workflow / Agent 工具) 的成败原本对主循环完全不可见: SubagentStop
 * 没有任何注册, 子 agent 干成什么样只留在它自己的上下文里。于是循环控制器看到
 * 的迭代史是残缺的 —— 三个子 agent 全挂了, 主循环仍以为这一轮什么也没发生。
 *
 * 本 hook 把子 agent 的判定落到当前 active 循环的 loop_iterations 上。
 *
 * 判定来源, 按可信度排序:
 *   1. 载荷里显式的结果字段 (tool_response / result / output)
 *   2. transcript_path 尾部的最后一段文本
 *   3. 都没有 → verdict='unknown', 并写明"载荷未提供可判读结果"
 *
 * 绝不猜 pass: 缺字段既不是成功也不是失败 (docs/rules/05-harness.md #1)。
 * 永远放行 —— 这是观察者, 不是门禁。
 */

const fs = require('node:fs');

const { payloadCwd, findProjectRoot, scopeId } = require('../lib/project-scope.cjs');
const { markerVerdict, isUnreadableVerdict } = require('../lib/verification-markers.cjs');

const BOM = new RegExp('^' + String.fromCharCode(0xFEFF));
/** transcript 只读尾部这么多字节 —— 判定标记总在最后, 没必要读整个会话。 */
const TRANSCRIPT_TAIL_BYTES = 16 * 1024;

function readPayload() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8').replace(BOM, ''); } catch { return {}; }
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function readOnlyMode() {
  return process.env.CLAUDE_HARNESS_NO_PERSIST === '1'
    || process.env.CLAUDE_NO_DIAGNOSTIC_WRITES === '1';
}

/** 读 transcript 尾部, 抽出最后的文本内容。 */
function tailTranscript(transcriptPath) {
  try {
    const stat = fs.statSync(transcriptPath);
    const start = Math.max(0, stat.size - TRANSCRIPT_TAIL_BYTES);
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const length = stat.size - start;
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, start);
      const lines = buffer.toString('utf8').split('\n').filter(Boolean);
      // JSONL: 从后往前找带文本内容的条目
      for (let i = lines.length - 1; i >= 0; i--) {
        let entry;
        try { entry = JSON.parse(lines[i]); } catch { continue; }
        const content = entry?.message?.content ?? entry?.content;
        if (typeof content === 'string' && content.trim()) return content;
        if (Array.isArray(content)) {
          const text = content
            .map((part) => (typeof part === 'string' ? part : part?.text || ''))
            .filter(Boolean).join('\n');
          if (text.trim()) return text;
        }
      }
      return '';
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/**
 * 从载荷里取出子 agent 的结果文本。
 * @returns {{ text: string, source: string }}
 */
function resultText(payload) {
  const direct = payload?.tool_response ?? payload?.result ?? payload?.output
    ?? payload?.agent_result ?? payload?.response;
  if (typeof direct === 'string' && direct.trim()) return { text: direct, source: 'payload' };
  if (direct && typeof direct === 'object') {
    const text = [direct.content, direct.text, direct.stdout, direct.result]
      .find((value) => typeof value === 'string' && value.trim());
    if (text) return { text, source: 'payload' };
  }
  const transcriptPath = payload?.transcript_path || payload?.transcriptPath;
  if (transcriptPath) {
    const text = tailTranscript(String(transcriptPath));
    if (text.trim()) return { text, source: 'transcript' };
  }
  return { text: '', source: 'none' };
}

/**
 * 计算这次 SubagentStop 该往循环里记什么。
 * @returns {{ recorded: boolean, reason?: string, verdict?: string, loopId?: string }}
 */
function evaluateSubagentStop(payload = {}, deps = {}) {
  const store = deps.store || require('../../sqlite/store-loops.cjs');
  const dbOpts = deps.db ? { db: deps.db } : {};

  const cwd = payloadCwd(payload, process.cwd());
  const projectRoot = findProjectRoot(cwd, { fallback: cwd });
  const sessionId = String(payload?.session_id || payload?.sessionId || '').trim();

  const loop = store.getActiveLoop({ scopeId: scopeId(projectRoot), sessionId }, dbOpts);
  if (!loop) return { recorded: false, reason: 'no_active_loop' };

  const { text, source } = resultText(payload);
  const marker = markerVerdict(text);
  const agentName = String(payload?.agent_name || payload?.subagent_type || payload?.agent_type || '')
    .slice(0, 60);

  // markerVerdict 的 unknown 分"没有输出"和"有输出但没有显式判定", 两者都不算通过
  const verdict = marker.status === 'passed' ? 'pass'
    : marker.status === 'failed' ? 'fail' : 'unknown';

  const summary = source === 'none'
    ? `subagent${agentName ? `(${agentName})` : ''}: 载荷未提供可判读结果`
    : `subagent${agentName ? `(${agentName})` : ''}: ${marker.reason}`;

  if (readOnlyMode()) {
    return { recorded: false, reason: 'read_only', verdict, loopId: loop.id };
  }

  let failure = null;
  if (verdict === 'fail') {
    const { signature } = require('../lib/failure-signature.cjs');
    failure = signature(text, { scope: loop.id, tool: 'subagent' });
  }

  store.recordIteration(loop.id, {
    verdict,
    actionSummary: summary,
    failureFp: failure && !failure.empty ? failure.fingerprint : null,
    failureFamily: failure && !failure.empty ? failure.family : null,
    strategy: null,
  }, dbOpts);

  return {
    recorded: true,
    verdict,
    loopId: loop.id,
    source,
    unreadable: isUnreadableVerdict(marker.reason),
  };
}

function main() {
  const payload = readPayload();
  try {
    const result = evaluateSubagentStop(payload);
    if (process.env.CLAUDE_SUBAGENT_VERDICT_DEBUG === '1') {
      process.stderr.write(`[subagent-verdict] ${JSON.stringify(result)}\n`);
    }
  } catch (error) {
    // 观察者绝不阻断子 agent 的收尾
    if (process.env.CLAUDE_SUBAGENT_VERDICT_DEBUG === '1') {
      process.stderr.write(`[subagent-verdict] fail-open: ${error.message}\n`);
    }
  }
}

if (require.main === module) main();

module.exports = { main, evaluateSubagentStop, resultText, tailTranscript };
