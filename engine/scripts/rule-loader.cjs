#!/usr/bin/env node
/**
 * engine/scripts/rule-loader.cjs — 规则加载机 L1 边界层
 *
 * 解析 rules/*.md 的 trigger/skip frontmatter，在对应场景程序化注入规则。
 * 这是从"Claude 自觉遵守"到"程序化强制加载"的关键转变。
 *
 * 工作原理:
 *   1. 扫描 rules/*.md 解析 YAML frontmatter
 *   2. 提取每个规则的 trigger / skip 关键词
 *   3. 评估当前上下文（用户消息、文件操作）
 *   4. 输出匹配的规则路径列表
 *
 * 注入方式:
 *   通过 hookSpecificOutput.additionalContext 注入到 Claude 上下文，
 *   格式与 frustration-detector 一致。
 *
 * 注册:
 *   settings.local.json PreToolUse matcher="*" — 每次工具调用前触发
 *
 * 使用场景:
 *   - 用户说"写RTL" → 自动注入 01-hdl.md
 *   - 用户说"查一下" → 自动注入 09-search-tools.md
 *   - 无匹配 → 不注入任何东西（0 token 开销）
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { HARNESS_ROOT } = require('./lib/harness-root.cjs');

// ── 配置 ────────────────────────────────────────────────────────────────────

const RULES_DIR = path.join(HARNESS_ROOT, 'rules');
const STATE_FILE = path.join(HARNESS_ROOT, 'var', 'index', 'runtime-state.json');
const DEFAULT_CAPSULE_MAX_CHARS = 1800;

// ── Frontmatter 解析 ─────────────────────────────────────────────────────────

/**
 * 解析 Markdown 文件的 YAML frontmatter。
 * @param {string} content - 完整文件内容
 * @returns {{ frontmatter: object, body: string, parsed: boolean }}
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/);
  if (!match) return { frontmatter: {}, body: content, parsed: false };

  const yamlText = match[1];
  const body = (match[2] || '').trim();
  const frontmatter = {};

  for (const line of yamlText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed === '') continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1 || colonIdx === 0) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    // Strip quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    frontmatter[key] = value;
  }

  return { frontmatter, body, parsed: true };
}

function splitFrontmatterList(value) {
  if (!value || typeof value !== 'string') return [];
  return value
    .split(/[;,，、|/]/)
    .map(s => s.trim())
    .filter(Boolean);
}

// ── 规则索引 ─────────────────────────────────────────────────────────────────

/**
 * 加载并解析所有规则文件，建立内存索引。
 * @returns {Array<{ file: string, name: string, priority: string, triggers: string[], skips: string[], description: string }>}
 */
let _ruleIndex = null;

function buildRuleIndex() {
  if (_ruleIndex) return _ruleIndex;

  const rules = [];

  if (!fs.existsSync(RULES_DIR)) {
    _ruleIndex = rules;
    return rules;
  }

  const files = fs.readdirSync(RULES_DIR)
    .filter(f => f.endsWith('.md'))
    .sort(); // 按文件名排序，保证确定性

  for (const file of files) {
    const filePath = path.join(RULES_DIR, file);
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const { frontmatter } = parseFrontmatter(content);

      // 解析 trigger 字符串 → 关键词数组
      const triggerStr = frontmatter.trigger || '';
      const triggers = splitFrontmatterList(triggerStr);

      // 解析 skip 字符串 → 关键词数组
      const skipStr = frontmatter.skip || '';
      const skips = splitFrontmatterList(skipStr);

      rules.push({
        file,
        name: frontmatter.name || file,
        priority: frontmatter.priority || 'L4',
        triggers,
        skips,
        description: frontmatter.description || '',
      });
    } catch (e) {
      console.error('[rule-loader] 错误:', e.message);
    }
  }

  _ruleIndex = rules;
  return rules;
}

/**
 * 清除规则索引缓存，下次调用时重新扫描。
 */
function invalidateRuleIndex() {
  _ruleIndex = null;
}

// ── 上下文匹配 ───────────────────────────────────────────────────────────────

/**
 * 评估用户输入是否匹配规则触发条件。
 * @param {string} input - 用户消息
 * @param {object} [opts]
 * @param {string[]} [opts.openFiles] - 当前打开的文件列表
 * @param {string[]} [opts.toolNames] - 最近调用的工具名
 * @returns {Array<{ file: string, name: string, priority: string, description: string, matchType: string, matchedTerm: string }>}
 */
function matchRules(input, opts = {}) {
  const rules = buildRuleIndex();
  const matches = [];

  // 规范化输入
  const normalizedInput = (input || '').toLowerCase();
  const openFiles = (opts.openFiles || []).map(f => f.toLowerCase());
  const toolNames = (opts.toolNames || []).map(t => t.toLowerCase());

  for (const rule of rules) {
    // 1. 检查 skip 条件 — 如果匹配 skip 则跳过
    //    skip 使用严格模式（无 char-seed 模糊匹配），防止过度排除
    const skipMatch = matchTriggerPatterns(normalizedInput, rule.skips, openFiles, toolNames, true);
    if (skipMatch) continue;

    // 2. 检查 trigger 条件
    const triggerMatch = matchTriggerPatterns(normalizedInput, rule.triggers, openFiles, toolNames, false);
    if (triggerMatch) {
      matches.push({
        file: rule.file,
        name: rule.name,
        priority: rule.priority,
        description: rule.description,
        matchType: triggerMatch.type,
        matchedTerm: triggerMatch.term,
        ...(triggerMatch.matchedChars ? { matchedChars: triggerMatch.matchedChars } : {}),
      });
    }
  }

  // 按优先级排序: L0 > L1 > L2 > L3 > L4
  const PRIORITY_ORDER = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 };
  matches.sort((a, b) => {
    const pa = PRIORITY_ORDER[a.priority] ?? 5;
    const pb = PRIORITY_ORDER[b.priority] ?? 5;
    return pa - pb;
  });

  return matches;
}

/**
 * 匹配单个触发模式集合。
 * @param {string} input
 * @param {string[]} patterns
 * @param {string[]} openFiles
 * @param {string[]} toolNames
 * @returns {{ type: string, term: string } | null}
 */
function matchTriggerPatterns(input, patterns, openFiles, toolNames, strict) {
  if (!patterns || patterns.length === 0) return null;

  for (const pattern of patterns) {
    if (!pattern) continue;

    // 特殊关键词: "始终加载" / "永不跳过" / "always" — 总是匹配
    if (pattern === '始终加载' || pattern === '永不跳过' || ['always', 'always_load', 'always load'].includes(pattern.toLowerCase())) {
      return { type: 'always', term: pattern };
    }

    // 特殊关键词: "永不加载" / "从不" — 从不匹配
    if (pattern === '永不加载' || pattern === '从不') {
      continue;
    }

    const lowPattern = pattern.toLowerCase();

    // 关键词匹配用户输入
    if (input && input.includes(lowPattern)) {
      return { type: 'keyword', term: pattern };
    }

    // 严格模式（skip 使用）— 只用关键词精确匹配，不进入模糊匹配
    if (strict) continue;

    // 中文单字种子匹配：对于多字中文触发词（如"搜索"→匹配"搜一下"、"仿真报错"→匹配"仿真跑不通"）
    // 如果触发词中有≥2个中文字且输入中至少包含其中1个 → 匹配
    // 注意：skip 规则走严格模式（strict=true），不进入此分支
    if (input && /[一-鿿]/.test(lowPattern)) {
      const chineseChars = lowPattern.split('').filter(c => /[一-鿿]/.test(c));
      // 常见虚词/介词/方位词/数量词不参与单字匹配（避免误触）
      const stopChars = new Set(['的', '了', '在', '有', '和', '就', '这', '那', '不', '也', '是', '被', '把', '为', '与', '其', '或', '但', '而', '及', '之', '对', '以',
        '上', '下', '左', '右', '前', '后', '里', '外', '中', '内', '间', '旁',
        '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '几', '多', '少',
        '个', '些', '种', '样', '等', '每', '各']);
      const meaningfulChars = chineseChars.filter(c => !stopChars.has(c));
      if (meaningfulChars.length < 2) continue; // 至少需要 2 个有意义的汉字

      // 计算用户输入中有多少个有意义的汉字命中了触发词中的汉字
      const inputChars = input.split('').filter(c => /[一-鿿]/.test(c) && !stopChars.has(c));
      const overlapCount = meaningfulChars.filter(c => inputChars.includes(c)).length;

      // 阈值规则:
      //   - 2 字触发词: 至少命中 1 字，且输入有意义汉字 ≤10（短路保护）
      //   - 3 字及以上触发词: 至少命中 2 字
      //   - 命中字数/触发词字数 ≥ 0.5（比例保护，避免长输入靠单个字命中）
      const ratio = overlapCount / meaningfulChars.length;
      const shortInputGuard = inputChars.length <= 10;

      if (meaningfulChars.length === 2 && overlapCount >= 1 && shortInputGuard && ratio >= 0.5) {
        return { type: 'char-seed', term: pattern, matchedChars: meaningfulChars.filter(c => inputChars.includes(c)) };
      }
      if (meaningfulChars.length >= 3 && overlapCount >= 2 && ratio >= 0.5) {
        return { type: 'char-seed', term: pattern, matchedChars: meaningfulChars.filter(c => inputChars.includes(c)) };
      }
    }

    // 文件扩展名匹配（如 .sv .v .py）
    if (pattern.startsWith('.') && openFiles.some(f => f.endsWith(pattern))) {
      return { type: 'extension', term: pattern };
    }
  }

  return null;
}

// ── 规则内容加载（用于注入）─────────────────────────────────────────────────

/**
 * 加载指定规则文件的完整内容。
 * @param {string} fileName
 * @returns {string|null}
 */
function loadRuleContent(fileName) {
  const filePath = path.join(RULES_DIR, fileName);
  if (!fs.existsSync(filePath)) return null;
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    console.error('[rule-loader] 错误:', e.message);
    return null;
  }
}

/**
 * 获取当前所有规则的简要摘要。
 * @returns {string}
 */
function getRuleSummary() {
  const rules = buildRuleIndex();
  const lines = [];
  for (const r of rules) {
    const triggerStr = r.triggers.length > 0 ? ` ⇨ ${r.triggers.slice(0, 3).join(', ')}` : '';
    lines.push(`  [${r.priority}] ${r.file} — ${r.description}${triggerStr}`);
  }
  return lines.join('\n');
}

function ruleCapsuleLine(rule) {
  const trigger = rule.matchedTerm ? ` via ${rule.matchedTerm}` : '';
  const desc = rule.description || rule.name || rule.file;
  return `[${rule.priority}] ${rule.file}: ${desc}${trigger}`;
}

function buildRuleCapsule(rules, opts = {}) {
  const maxChars = Number.parseInt(
    opts.maxChars || process.env.CLAUDE_RULE_CAPSULE_MAX_CHARS || DEFAULT_CAPSULE_MAX_CHARS,
    10
  );
  const lines = [
    'Harness rule capsule: obey these rule files; hooks enforce hard gates.',
    ...rules.map(ruleCapsuleLine),
    'Read full rule files only when implementation details are needed.',
  ];
  const text = lines.join('\n');
  if (Number.isFinite(maxChars) && maxChars > 0 && text.length > maxChars) {
    return `${text.slice(0, Math.max(0, maxChars - 32)).trimEnd()}\n...(capsule truncated)`;
  }
  return text;
}

function shouldIncludeRuleContents(opts = {}) {
  return opts.verbose === true ||
    process.env.CLAUDE_RULE_VERBOSE === '1' ||
    process.env.CLAUDE_RULE_FULL_CONTEXT === '1';
}

// ── 主逻辑 — 供 hook 调用 ────────────────────────────────────────────────────

/**
 * 主入口：分析当前上下文，输出需要注入的规则。
 *
 * 输出格式（JSON 行，与 frustration-detector 一致）:
 * {
 *   source: "rule-loader",
 *   type: "rule-inject-suggest",
 *   matches: [{ file, name, priority, matchType }],
 *   summary: "...",
 *   ruleContents: { "01-hdl.md": "..." }  // 匹配规则的完整内容
 * }
 *
 * @param {string} userMessage - 当前用户消息
 * @param {object} [opts]
 * @param {string[]} [opts.openFiles] - 当前打开的文件
 * @returns {object|null}
 */
function evaluate(userMessage, opts = {}) {
  const openFiles = opts.openFiles || [];
  const toolNames = opts.toolNames || [];
  const hasContextSignal = Boolean(userMessage) || openFiles.length > 0 || toolNames.length > 0;
  if (!hasContextSignal && process.env.CLAUDE_RULE_ALWAYS_LOAD !== '1') {
    return null;
  }

  const matches = matchRules(userMessage, {
    openFiles,
    toolNames,
  });

  if (matches.length === 0) {
    return null; // 无匹配 → 不注入任何东西
  }

  // L0 是硬约束，必须全部加载；L1/L2 再按相关性补充。
  const l0 = matches.filter(m => m.priority === 'L0');
  const l1 = matches.filter(m => m.priority === 'L1').slice(0, 3);
  const supplement = matches.filter(m => m.priority === 'L2').slice(0, Math.max(0, 4 - l0.length - l1.length));
  const seenFiles = new Set();
  const toLoad = [...l0, ...l1, ...supplement].filter(rule => {
    if (seenFiles.has(rule.file)) return false;
    seenFiles.add(rule.file);
    return true;
  });

  const verbose = shouldIncludeRuleContents(opts);
  const ruleContents = {};
  if (verbose) {
    for (const rule of toLoad) {
      const content = loadRuleContent(rule.file);
      if (content) {
        // 去除 frontmatter，只保留正文
        const { body } = parseFrontmatter(content);
        ruleContents[rule.file] = body;
      }
    }
  }

  // Emit signal: 规则加载事件
  if (process.env.CLAUDE_RULE_SIGNAL_DISABLED !== '1') {
    try {
      const { emitSync } = require('../hooks/learning/signal-collector.cjs');
      emitSync('rule_load', {
        files: toLoad.map(r => r.file),
        priorities: toLoad.map(r => r.priority),
        matchCount: matches.length,
      });
    } catch (e) { console.error('[rule-loader] 错误:', e.message); }
  }

  return {
    source: 'rule-loader',
    type: 'rule-inject-suggest',
    mode: verbose ? 'verbose' : 'capsule',
    matches: toLoad,
    ruleRefs: toLoad.map(r => ({
      file: r.file,
      priority: r.priority,
      name: r.name,
      description: r.description,
      matchedTerm: r.matchedTerm,
    })),
    capsule: buildRuleCapsule(toLoad, opts),
    ...(verbose ? { ruleContents } : {}),
    allMatches: matches.map(m => `${m.file}[${m.priority}]`),
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  switch (cmd) {
    case 'index':
      // 重新索引并输出摘要
      invalidateRuleIndex();
      const rules = buildRuleIndex();
      console.log(`规则总数: ${rules.length}`);
      for (const r of rules) {
        const t = r.triggers.join(', ') || '(无触发条件)';
        const s = r.skips.join(', ') || '(无跳过条件)';
        console.log(`  [${r.priority}] ${r.file}`);
        console.log(`    触发: ${t}`);
        console.log(`    跳过: ${s}`);
      }
      break;

    case 'match':
      // 测试匹配: node rule-loader.cjs match "写RTL" --files="top.sv"
      const input = args[1] || process.env.CLAUDE_USER_MESSAGE || '';
      const files = args.find(a => a.startsWith('--files='))?.split('=')[1]?.split(',') || [];
      const result = evaluate(input, { openFiles: files, verbose: args.includes('--verbose') });
      if (result) {
        console.log(JSON.stringify(result, null, 2));
        if (result.ruleContents) {
          console.log('\n--- 注入规则内容 ---');
          for (const [file, content] of Object.entries(result.ruleContents)) {
            console.log(`\n=== ${file} ===`);
            console.log(content.slice(0, 500) + (content.length > 500 ? '\n...(截断)' : ''));
          }
        }
      } else {
        console.log('无匹配规则');
      }
      break;

    case 'summary':
      console.log(getRuleSummary());
      break;

    default:
      // 默认模式：作为 Claude Code hook 运行。
      // 输入走 stdin 的 hook payload —— 平台从不设置 CLAUDE_USER_MESSAGE /
      // CLAUDE_OPEN_FILES, 早期版本只读这两个环境变量, 导致本 hook 永远
      // 拿不到上下文信号, evaluate() 每次直接 return null (触发率 0%)。
      // 环境变量保留为回退, 以兼容手工调用。
      runAsHook();
      break;
  }
}

// ── Hook 运行时 ───────────────────────────────────────────────────────────

function readStdinRaw() {
  try {
    if (process.stdin.isTTY) return '';
    return fs.readFileSync(0, 'utf8').replace(/^﻿/, '');
  } catch {
    return '';
  }
}

function parsePayload(raw) {
  if (!raw || !raw.trim()) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

/** 同一 session 内已注入过的规则不重复注入, 避免每轮刷屏与 token 浪费。 */
function injectionMemoPath(sessionId) {
  const safe = String(sessionId || 'no-session').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  return path.join(HARNESS_ROOT, 'var', 'rule-loader', `injected-${safe}.json`);
}

function loadInjected(sessionId) {
  try {
    const raw = fs.readFileSync(injectionMemoPath(sessionId), 'utf8');
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed.files) ? parsed.files : []);
  } catch {
    return new Set();
  }
}

function saveInjected(sessionId, files) {
  try {
    const target = injectionMemoPath(sessionId);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ files: [...files], updatedAt: new Date().toISOString() }), 'utf8');
    fs.renameSync(tmp, target);
  } catch { /* 注入记忆写失败不影响主流程 */ }
}

function runAsHook() {
  const payload = parsePayload(readStdinRaw());
  const eventName = payload.hook_event_name || '';
  const toolInput = payload.tool_input || payload.tool?.input || {};

  // UserPromptSubmit 是主路径; PreToolUse 时退化为按文件类型匹配。
  const userMessage = payload.prompt
    || payload.user_prompt
    || process.env.CLAUDE_USER_MESSAGE
    || '';
  const openFiles = [toolInput.file_path, toolInput.notebook_path]
    .filter(Boolean)
    .concat((process.env.CLAUDE_OPEN_FILES || '').split(',').filter(Boolean));
  const toolNames = [payload.tool_name || payload.tool?.name].filter(Boolean);

  const result = evaluate(userMessage, { openFiles, toolNames });
  if (!result) return;

  // evaluate() 有两种输出形态:
  //   capsule 模式 — result.capsule (紧凑摘要) + result.ruleRefs
  //   full 模式    — result.ruleContents (规则全文)
  // 默认走 capsule, 符合 rules/00-core.md 的"capsule 足够时不读取全文"。
  const refFiles = Array.isArray(result.ruleRefs)
    ? result.ruleRefs.map(r => r.file)
    : Object.keys(result.ruleContents || {});
  if (refFiles.length === 0) return;

  const sessionId = payload.session_id || payload.sessionId || '';
  const already = loadInjected(sessionId);
  const fresh = refFiles.filter(file => !already.has(file));
  if (fresh.length === 0) return; // 本 session 已注入过 → 0 token

  let body;
  if (result.ruleContents && Object.keys(result.ruleContents).length > 0) {
    body = fresh
      .filter(file => result.ruleContents[file])
      .map(file => `### ${file}\n${result.ruleContents[file]}`)
      .join('\n\n');
  } else {
    body = String(result.capsule || '');
  }
  if (!body.trim()) return;

  const additionalContext = `[rule-loader] 与当前任务相关的规则:\n\n${body}`;

  // Claude Code 只把 hookSpecificOutput.additionalContext 注入模型上下文;
  // 裸 console.log 的文本只会进日志, 不进上下文。
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: eventName || 'UserPromptSubmit',
      additionalContext,
    },
  }));

  for (const file of fresh) already.add(file);
  saveInjected(sessionId, already);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildRuleIndex,
  invalidateRuleIndex,
  matchRules,
  evaluate,
  loadRuleContent,
  getRuleSummary,
  parseFrontmatter,
};
