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
const HOMEDIR = require('os').homedir();

// ── 配置 ────────────────────────────────────────────────────────────────────

const RULES_DIR = path.join(HOMEDIR, '.claude', 'rules');
const STATE_FILE = path.join(HOMEDIR, '.claude', 'var', 'index', 'runtime-state.json');

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
      const triggers = triggerStr
        .split(/[，,、\/]/)
        .map(s => s.trim())
        .filter(Boolean);

      // 解析 skip 字符串 → 关键词数组
      const skipStr = frontmatter.skip || '';
      const skips = skipStr
        .split(/[，,、\/]/)
        .map(s => s.trim())
        .filter(Boolean);

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

    // 特殊关键词: "始终加载" / "永不跳过" — 总是匹配
    if (pattern === '始终加载' || pattern === '永不跳过') {
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
  const matches = matchRules(userMessage, {
    openFiles: opts.openFiles || [],
    toolNames: opts.toolNames || [],
  });

  if (matches.length === 0) {
    return null; // 无匹配 → 不注入任何东西
  }

  // 只加载 L0/L1 优先级的规则（高优先级），最多 2 个
  const highPriority = matches.filter(m => ['L0', 'L1'].includes(m.priority)).slice(0, 2);
  // 如果高优先级不够，补充 L2
  const supplement = matches.filter(m => m.priority === 'L2').slice(0, 2 - highPriority.length);
  const toLoad = [...highPriority, ...supplement];

  // 加载规则内容
  const ruleContents = {};
  for (const rule of toLoad) {
    const content = loadRuleContent(rule.file);
    if (content) {
      // 去除 frontmatter，只保留正文
      const { body } = parseFrontmatter(content);
      ruleContents[rule.file] = body;
    }
  }

  // Emit signal: 规则加载事件
  try {
    const { emitSync } = require('../hooks/learning/signal-collector.cjs');
    emitSync('rule_load', {
      files: toLoad.map(r => r.file),
      priorities: toLoad.map(r => r.priority),
      matchCount: matches.length,
    });
  } catch (e) { console.error('[rule-loader] 错误:', e.message); }

  return {
    source: 'rule-loader',
    type: 'rule-inject-suggest',
    matches: toLoad,
    ruleContents,
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
      const result = evaluate(input, { openFiles: files });
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
      // 默认模式：从 CLAUDE_USER_MESSAGE 读取用户消息并输出注入结果
      const userMsg = process.env.CLAUDE_USER_MESSAGE || '';
      const evalResult = evaluate(userMsg, {
        openFiles: (process.env.CLAUDE_OPEN_FILES || '').split(',').filter(Boolean),
      });
      if (evalResult) {
        // 输出 JSON 行，hook 框架将其注入到 Claude 上下文
        console.log(JSON.stringify(evalResult));
      }
      // 无匹配 → 无输出（0 token 开销）
      break;
  }
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
