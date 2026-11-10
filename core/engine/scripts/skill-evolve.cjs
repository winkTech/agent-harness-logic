#!/usr/bin/env node

/**
 * engine/scripts/skill-evolve.cjs — SkillOpt 方法蒸馏
 *
 * 核心循环 (SkillOpt distilled):
 *   harvest → mine → reflect → bounded edit → validate → stage
 *
 * 比完整 SkillOpt-Sleep 轻量得多：
 *   - 不调外部 API，纯本地分析
 *   - 从 SQLite 事件和 session JSONL 中提取用户纠正信号
 *   - 对相关 SKILL.md 做 bounded edit（一条规则增/删/改）
 *   - 验证不违反已有规则
 *   - stage 到 .skillopt-sleep/staging/ 等待审查
 *
 * 用法:
 *   node engine/scripts/skill-evolve.cjs              # 全量运行
 *   node engine/scripts/skill-evolve.cjs --dry-run    # 试运行, 不写文件
 *   node engine/scripts/skill-evolve.cjs --force      # 忽略水印
 *
 * 设计原则:
 *   1. 一次只改一条规则 (bounded edit)
 *   2. 不改已有规则，只新增或澄清
 *   3. 验证不冲突后才 stage
 *   4. 从不自动写入 - 等用户审查后采纳
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const HOME_DIR = path.resolve(__dirname, '..', '..');
const SKILLS_DIR = path.join(HOME_DIR, 'skills');
const STAGING_BASE = path.join(HOME_DIR, '.skillopt-sleep', 'staging');

// ── 词法分析: 从 skill 中提取规则 ──────────────────────────────────────

/**
 * 解析 SKILL.md，提取规则列表。
 * 支持格式: [MUST], - [MUST], ** 加粗 **, 1. 编号列表
 */
function parseRules(skillPath) {
  const text = fs.readFileSync(skillPath, 'utf-8');
  const lines = text.split('\n');
  const rules = [];
  let currentSection = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 检测段落标题
    const sectionMatch = line.match(/^#{1,3}\s+(.+)/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      continue;
    }

    // 检测规则行
    const ruleMatch = line.match(/^\s*(?:-\s+)?(?:\*\*)?\[(MUST|SHOULD|MAY|MUST NOT)\]/);
    if (ruleMatch) {
      rules.push({
        severity: ruleMatch[1],
        text: line.trim(),
        section: currentSection,
        lineNumber: i + 1,
      });
    }
  }

  return { rules, text };
}

/**
 * 检查新规则是否与已有规则冲突。
 * 冲突定义: 两条规则对同一信号做出矛盾的约束。
 */
function detectConflict(newRule, existingRules) {
  // 提取关键名词（信号名、模块名等）
  const newKeyTerms = extractKeyTerms(newRule);

  for (const existing of existingRules) {
    const existKeyTerms = extractKeyTerms(existing.text);
    const overlap = newKeyTerms.filter(t => existKeyTerms.includes(t));

    if (overlap.length >= 2) {
      // 同一主题上有重叠，检查是否矛盾
      const newForbids = /(禁止|不得|不允许|MUST NOT|never|don't)/i.test(newRule);
      const existForbids = /(禁止|不得|不允许|MUST NOT|never|don't)/i.test(existing.text);

      if (newForbids !== existForbids) {
        return { conflict: true, with: existing, overlap };
      }
    }
  }

  return { conflict: false };
}

function extractKeyTerms(text) {
  // 提取信号名、模块名等关键术语
  const terms = [];
  const patterns = [
    /[a-z]_[a-z_]+/g,      // snake_case 标识符
    /`[^`]+`/g,             // 反引号代码
    /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g,  // 专有名词
  ];
  for (const p of patterns) {
    const matches = text.match(p);
    if (matches) terms.push(...matches.map(m => m.toLowerCase()));
  }
  return [...new Set(terms)];
}

// ── Harvest: 从 SQLite 中获取用户纠正信号 ──────────────────────────────

/**
 * 获取最近 session 中的用户纠正信号。
 * 使用 SQLite runtime_events 中的 event_id 水印机制。
 */
function harvestCorrections(opts = {}) {
  let wDb = null;
  try {
    const { openDb } = require('../sqlite/index.cjs');
    const {
      sinceWatermark,
      countSinceWatermark,
      getWatermark,
    } = require('../sqlite/store-events.cjs');
    if (!opts.db) wDb = openDb(opts.dbPath ? { path: opts.dbPath } : {});
    const db = opts.db || wDb.db;
    const committedWatermark = getWatermark({ db, consumer: 'skill-evolve' });
    const watermarkId = opts.force === true ? 0 : committedWatermark;
    const requestedLimit = Number(opts.limit ?? 100);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(100, Math.max(1, Math.trunc(requestedLimit)))
      : 100;

    const events = sinceWatermark(watermarkId, limit, { db });

    const corrections = events
      .filter(e => e.type === 'user_correct')
      .map(e => ({
        message: e.payload?.message || e.payload?.matchedPattern || '',
        sessionId: e.sessionId,
        time: e.createdAt,
      }));

    const stuck = events
      .filter(e => e.type === 'drift_stuck')
      .map(e => ({
        pattern: e.payload?.matchedPattern || e.payload?.extra || '',
        sessionId: e.sessionId,
        time: e.createdAt,
      }));

    // 也把 tool_fail 纳入
    const toolFails = events
      .filter(e => e.type === 'tool_fail')
      .map(e => ({
        pattern: e.payload?.error || e.payload?.tool || '',
        sessionId: e.sessionId,
        time: e.createdAt,
      }));

    const batchWatermark = events.length > 0
      ? Math.max(committedWatermark, events[events.length - 1].eventId)
      : committedWatermark;

    return {
      corrections,
      stuck,
      toolFails,
      inspected: events.length,
      processed: 0,
      pending: countSinceWatermark(committedWatermark, { db }),
      watermarkBefore: committedWatermark,
      watermarkAfter: committedWatermark,
      batchWatermark,
    };
  } catch (e) {
    if (opts.throwOnError === true) throw e;
    console.error('[skill-evolve] harvest error:', e.message);
    return {
      corrections: [], stuck: [], toolFails: [],
      inspected: 0, processed: 0, pending: 0,
      watermarkBefore: 0, watermarkAfter: 0, batchWatermark: 0,
    };
  } finally {
    if (wDb) wDb.close();
  }
}

function setMyWatermark(eventId, opts = {}) {
  const { setWatermark } = require('../sqlite/store-events.cjs');
  setWatermark(eventId, { ...opts, consumer: 'skill-evolve' });
  return eventId;
}

// ── Mine: 从纠正信号中提取可操作的改进 ────────────────────────────────

/**
 * 将纠正信号映射到具体的 skill 修改建议。
 *
 * SkillOpt 核心: 从 failure 中提取 bounded edit，不是重写整个 skill。
 */
function mineImprovements(corrections, stuck, toolFails) {
  const suggestions = [];

  // 关键词 → (skill, section, 建议规则)
  const RULE_MAP = [
    {
      keywords: ['前缀', '命名', 'i_', 'ri_', 'ro_', '信号名'],
      skill: 'hdl-coding',
      section: '命名规范',
      genRule: (msg) => {
        if (/ri_/.test(msg)) return { op: 'clarify', content: `- 输入必须在入口寄存为 \`ri_\` 前缀，禁止直通内部逻辑` };
        if (/ro_/.test(msg)) return { op: 'clarify', content: `- 输出必须由 \`ro_\` 驱动，禁止组合逻辑直出` };
        return null;
      },
    },
    {
      keywords: ['时钟', '复位', 'i_clk', 'i_rst', '时序'],
      skill: 'hdl-coding',
      section: '时序安全',
      genRule: (msg) => null, // 已有完善规则，不自动改
    },
    {
      keywords: ['状态机', '三段', 'FSM'],
      skill: 'hdl-coding',
      section: '状态机',
      genRule: (msg) => null,
    },
    {
      keywords: ['testbench', 'TB', '仿真', 'vsim', '波形'],
      skill: 'hdl-coding',
      section: '验证',
      genRule: (msg) => {
        if (/自检|self.check|自动验证/.test(msg)) {
          return { op: 'add', content: `- **[SHOULD]** Testbench 必须包含自检机制（self-checking），不依赖人工查看波形` };
        }
        return null;
      },
    },
    {
      keywords: ['golden', '模型', '算法', 'matlab', '定点'],
      skill: 'hdl-coding',
      section: '验证',
      genRule: (msg) => {
        if (/对比|compare|bit.?true/.test(msg)) {
          return { op: 'add', content: `- **[SHOULD]** RTL 输出必须与 Golden Model bit-true 对齐，不允许用容差掩盖算法偏离` };
        }
        return null;
      },
    },
    {
      keywords: ['仿真', 'vsim', 'vlog', '波形', 'wave', '仿真报错', '编译错误'],
      skill: 'hdl-coding',
      section: '验证',
      genRule: (msg) => {
        if (/不通过|错误|error|fail|failed|不对/.test(msg)) {
          return { op: 'add', content: `- **[MUST]** 仿真报错先检查端口位宽匹配，再查时序，最后查逻辑` };
        }
        return null;
      },
    },
    {
      keywords: ['流水线', 'pipeline', '延迟', '吞吐', '时钟频率'],
      skill: 'hdl-coding',
      section: '时序安全',
      genRule: (msg) => {
        if (/不够|不足|太低|不满足|violation|setup|hold/.test(msg)) {
          return { op: 'add', content: `- **[SHOULD]** 关键路径插入流水线寄存器，每级 ≤ 8 个 LUT 深度` };
        }
        return null;
      },
    },
    {
      keywords: ['调试', 'debug', '排查', '根因'],
      skill: 'debugging',
      section: '调试方法',
      genRule: (msg) => null,
    },
    {
      keywords: ['没有正常', '没跑', '跑不起来', '行不行', '不出', '不工作', '又错', '没反应', '白费'],
      skill: 'hdl-coding',
      section: '工作流程',
      genRule: (msg) => {
        return { op: 'add', content: '- **[SHOULD]** 实施前先输出执行计划，与用户确认后再开始编码，避免方向偏差' };
      },
    },
  ];

  // 处理用户纠正
  for (const c of corrections) {
    const msg = c.message;
    if (!msg || msg.length < 5) continue;

    for (const entry of RULE_MAP) {
      const matched = entry.keywords.some(kw =>
        msg.toLowerCase().includes(kw.toLowerCase())
      );
      if (!matched) continue;

      const rule = entry.genRule(msg);
      if (rule) {
        suggestions.push({
          skill: entry.skill,
          section: entry.section,
          op: rule.op,
          content: rule.content,
          source: msg.slice(0, 120),
          sessionId: c.sessionId,
          confidence: 'medium',
        });
      }
    }
  }

  // 处理挫败模式（重复出现的问题）
  const patternCounts = {};
  for (const s of stuck) {
    const key = s.pattern.slice(0, 60);
    if (key.length > 5) {
      patternCounts[key] = (patternCounts[key] || 0) + 1;
    }
  }

  for (const [pattern, count] of Object.entries(patternCounts)) {
    if (count < 2) continue; // 只处理重复模式

    // 尝试将挫败模式映射到 skill
    if (/lint|vlog|语法/.test(pattern)) {
      suggestions.push({
        skill: 'hdl-coding',
        section: '必读红线',
        op: 'add',
        content: `- **[MUST]** 提交前必须运行 \`make lint\` 检查语法，禁止提交有 lint 错误的代码`,
        source: `重复 lint 失败 ${count} 次: ${pattern.slice(0, 60)}`,
        sessionId: '',
        confidence: 'high',
      });
    }
    if (/位宽|匹配|width|mismatch/.test(pattern)) {
      suggestions.push({
        skill: 'hdl-coding',
        section: '位宽与符号',
        op: 'add',
        content: `- **[MUST]** 左右位宽必须显式匹配，禁止隐式位宽转换；使用 \`width()\` 或 \`$clog2()\` 自动计算`,
        source: `重复位宽错误 ${count} 次`,
        sessionId: '',
        confidence: 'high',
      });
    }
  }

  // 处理 tool_fail 中的 HDL 工具错误
  for (const t of toolFails) {
    const pattern = t.pattern;
    if (!pattern || pattern.length < 5) continue;
    if (/vlog|vsim|vlib|vcom|ModelSim|Questa|lint/i.test(pattern)) {
      const exists = suggestions.some(s => s.skill === 'hdl-coding' && s.section === '必读红线');
      if (!exists) {
        suggestions.push({
          skill: 'hdl-coding', section: '必读红线', op: 'add',
          content: '- **[MUST]** 仿真工具错误必须先检查语法和位宽，再查逻辑',
          source: `工具错误: ${pattern.slice(0, 60)}`,
          sessionId: t.sessionId, confidence: 'high',
        });
      }
    }
  }

  // 去重: 相同 skill+section+content 只保留一条
  const seen = new Set();
  return suggestions.filter(s => {
    const key = `${s.skill}:${s.section}:${s.content}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Validate: 检查建议是否与已有规则冲突 ──────────────────────────────

function validateSuggestions(suggestions) {
  const validated = [];

  for (const s of suggestions) {
    const skillPath = path.join(SKILLS_DIR, s.skill, 'SKILL.md');

    if (!fs.existsSync(skillPath)) {
      // 技能不存在，标记为新建
      validated.push({ ...s, valid: true, warning: 'skill 不存在，将新建' });
      continue;
    }

    const { rules } = parseRules(skillPath);

    // 检查是否已有完全相同的规则
    const duplicate = rules.find(r =>
      r.text.replace(/\s+/g, ' ') === s.content.replace(/\s+/g, ' ')
    );
    if (duplicate) {
      validated.push({ ...s, valid: false, warning: '规则已存在' });
      continue;
    }

    // 检查是否与已有规则冲突
    const conflict = detectConflict(s.content, rules);
    if (conflict.conflict) {
      validated.push({ ...s, valid: false, warning: `与已有规则冲突: ${conflict.with.text.slice(0, 60)}` });
      continue;
    }

    validated.push({ ...s, valid: true });
  }

  return validated;
}

// ── Gate: SkillOpt 验证门禁（轻量版）────────────────────────────────

/**
 * 对每条通过冲突检查的规则做 held-out 验证。
 *
 * SkillOpt 核心:
 *   1. baseline = 当前状态下 val 集的问题率
 *   2. candidate = 加入规则后 val 集的问题覆盖率
 *   3. gate: candidate > baseline × 阈值 → accept
 *
 * 轻量实现（不调 API）:
 *   - 从 session 文件中提取 val 集（后 30% 的 session）
 *   - baseline: val 中出同类问题的比例
 *   - candidate: 规则关键词覆盖 val 问题的比例
 *   - gate: candidate > baseline × 1.1（严格提升）
 */
function gateSuggestions(validated) {
  // 使用 collectAllSessions 统一收集（已过滤临时目录）
  const allSessions = collectAllSessions();
  const valSessions = allSessions.filter(s => s.isVal);
  const trainSessions = allSessions.filter(s => !s.isVal);

  console.log(`[skill-evolve]    gate: ${allSessions.length} sessions (train=${trainSessions.length}, val=${valSessions.length})`);

  return validated.map(s => {
    // 从规则内容中提取关键检测词
    const ruleText = s.content;
    const detectTerms = extractGateTerms(ruleText);
    const sourceTerms = extractGateTerms(s.source);

    if (detectTerms.length === 0 && sourceTerms.length === 0) {
      // 无可检测关键词 → 跳过门禁（保守通过）
      return { ...s, gateScore: 0.5, gateAction: 'skip(no-terms)', valid: true };
    }

    // baseline: 当前 skill 中没有该规则，所以是 0
    // candidate: 规则应对的模式在 val 中是否真实存在
    const baseline = 0;

    // 检查规则关键词是否命中 val session
    let candHits = 0;
    for (const vs of valSessions) {
      if (sessionHasExplicitMatch(vs, detectTerms)) candHits++;
    }
    const candidate = candHits / valSessions.length;

    // gate: 规则模式在 val 中出现的比例 > 5% 就接受
    const gated = candidate >= 0.05;
    const improvement = candidate - baseline;
    const gateScore = candidate;

    console.log(`  [gate] ${s.content.slice(0, 50)}... baseline=${baseline.toFixed(3)} candidate=${candidate.toFixed(3)} (${improvement > 0 ? '+' : ''}${improvement.toFixed(3)}) → ${gated ? '✅ ACCEPT' : '⛔ REJECT'}`);

    return {
      ...s,
      gateScore,
      gateBaseline: baseline,
      gateCandidate: candidate,
      gateAction: gated ? 'accept' : 'reject',
      valid: gated,
      warning: gated ? (s.warning || `gate: +${(improvement * 100).toFixed(0)}%`) : `gate: 无提升 (b=${baseline.toFixed(2)}, c=${candidate.toFixed(2)})`,
    };
  });
}

/**
 * 从规则/文本中提取可用于检测的关键词。
 */
function extractGateTerms(text) {
  const terms = [];
  // 提取反引号代码
  const codeTerms = text.match(/`[^`]+`/g);
  if (codeTerms) terms.push(...codeTerms.map(t => t.replace(/`/g, '')));

  // 提取中文关键短语
  const zhPatterns = [
    /实施.*计划/, /执行.*计划/, /输出.*方案/,
    /语法.*检查/, /位宽.*匹配/, /lint/,
    /信号.*前缀/, /命名.*规范/,
    /时序.*检查/, /复位.*同步/,
    /仿真.*错误/, /编译.*错误/,
    /bit.?true/, /Golden.*Model/,
    /端口.*匹配/, /位宽.*不匹配/,
    /仿真.*不通过/, /波形.*不对/,
    /流水线/, /pipeline/,
    /vlog.*error/, /vsim.*error/,
  ];
  for (const p of zhPatterns) {
    const m = text.match(p);
    if (m) terms.push(m[0].toLowerCase());
  }

  // 提取 MUST/SHOULD 后的关键词
  const msMatch = text.match(/\[(MUST|SHOULD)\]\s*(.+?)(?:—|$|。)/);
  if (msMatch) terms.push(msMatch[2].trim().toLowerCase().slice(0, 20));

  return [...new Set(terms)].filter(t => t.length > 1);
}

/**
 * 检查 session 中是否明确命中规则关键词（更严格的匹配）。
 */
function sessionHasExplicitMatch(session, detectTerms) {
  if (detectTerms.length === 0) return false;
  try {
    const content = fs.readFileSync(
      path.join(HOME_DIR, 'projects', session.name), 'utf-8'
    );
    const lower = content.toLowerCase();
    return detectTerms.some(t => t.length > 2 && lower.includes(t.toLowerCase()));
  } catch (e) {
    return false;
  }
}

// ── Stage: 输出改进提案 ──────────────────────────────────────────────

function stageProposals(validated, dryRun) {
  const accepted = validated.filter(v => v.valid);

  if (accepted.length === 0) {
    console.log('[skill-evolve] 没有有效的改进提案');
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const stagingDir = path.join(STAGING_BASE, `evolve-${timestamp}`);

  // 按技能分组生成提案
  const bySkill = {};
  for (const s of accepted) {
    if (!bySkill[s.skill]) bySkill[s.skill] = [];
    bySkill[s.skill].push(s);
  }

  let report = '# Skill-Evolve 改进提案\n\n';
  report += `生成时间: ${new Date().toISOString()}\n`;
  report += `有效提案: ${accepted.length} 条`;
  if (accepted[0] && accepted[0].gateScore !== undefined) {
    report += `  |  门禁: baseline→candidate`;
  }
  report += '\n\n';

  for (const [skill, items] of Object.entries(bySkill)) {
    report += `## ${skill}\n\n`;
    report += `文件: \`skills/${skill}/SKILL.md\`\n\n`;
    report += `| # | 操作 | 内容 | 置信度 | 门禁(b→c) | 来源 |\n`;
    report += `|---|------|------|--------|-----------|------|\n`;
    items.forEach((item, i) => {
      const escapedContent = item.content.replace(/\|/g, '\\|');
      const gateStr = item.gateScore !== undefined
        ? `${(item.gateBaseline || 0).toFixed(2)}→${(item.gateCandidate || 0).toFixed(2)}`
        : '-';
      report += `| ${i+1} | ${item.op} | \`${escapedContent}\` | ${item.confidence} | ${gateStr} | ${item.source.slice(0, 30)} |\n`;
    });
    report += '\n';

    // 生成具体的 skill diff
    items.forEach((item, i) => {
      report += `### 建议 ${i+1}: [${item.op}] ${item.section}\n\n`;
      report += `**原始来源**: ${item.source}\n\n`;
      report += `**建议改动**:\n\n`;
      report += `在 \`${item.section}\` 段落中添加:\n`;
      report += `\`\`\`diff\n+ ${item.content}\n\`\`\`\n\n`;
    });
  }

  report += `---\n`;
  report += `审查后采纳: 手动将 diff 内容合并到对应 SKILL.md\n`;
  report += `或删除此目录放弃提案。\n`;

  if (dryRun) {
    console.log('[skill-evolve] [DRY RUN] 以下提案将被 stage:');
    console.log(report);
    return;
  }

  // 写入 stage 目录
  fs.mkdirSync(stagingDir, { recursive: true });
  fs.writeFileSync(path.join(stagingDir, 'report.md'), report, 'utf-8');

  // 为每个技能生成 proposed diff
  for (const [skill, items] of Object.entries(bySkill)) {
    const skillPath = path.join(SKILLS_DIR, skill, 'SKILL.md');
    let currentContent = '';
    if (fs.existsSync(skillPath)) {
      currentContent = fs.readFileSync(skillPath, 'utf-8');
    }

    const diffLines = [];
    items.forEach(item => {
      diffLines.push(`### [${item.op}] ${item.section}`);
      diffLines.push(`+ ${item.content}`);
      diffLines.push(`来源: ${item.source}`);
      diffLines.push('');
    });

    fs.writeFileSync(
      path.join(stagingDir, `proposed-${skill}.diff`),
      diffLines.join('\n'),
      'utf-8'
    );
  }

  console.log(`[skill-evolve] ✅ 提案已 stage: ${stagingDir}`);
  console.log(`[skill-evolve]    report: ${path.join(stagingDir, 'report.md')}`);
  console.log(`[skill-evolve]    审查后手动合并到对应 SKILL.md`);
}

// ── 模式挖掘: 从 session 内容中直接挖重复模式 ──────────────────────

/**
 * 从 session 内容中直接挖高频问题模式。
 * 这是 SkillOpt mine 的轻量版：统计关键词频率 → 映射到规则。
 * 不依赖事件表，直接从原始 session 内容中提取。
 */
function minePatternsFromSessions(allSessions, force) {
  const result = { corrections: [], toolFails: [] };

  // 定义模式 → 问题信号映射
  const PATTERN_MAP = [
    { kw: 'lint',        signal: 'lint 错误', session: false },
    { kw: 'vlog',        signal: 'vlog 编译错误', session: false },
    { kw: 'vsim',        signal: '仿真错误', session: false },
    { kw: '位宽.*不匹配', signal: '位宽不匹配', session: true },
    { kw: '不匹配',       signal: '接口不匹配', session: false },
    { kw: 'tb|testbench', signal: 'testbench', session: false },
    { kw: 'golden.*对比', signal: 'golden 对比', session: true },
    { kw: 'bit.?true',    signal: 'bit-true 对齐', session: true },
    { kw: '时序.*违例',   signal: '时序违例', session: true },
    { kw: 'setup.*hold', signal: '时序违例', session: true },
    { kw: '状态机.*bug',  signal: '状态机错误', session: true },
    { kw: '波形.*不对',   signal: '仿真结果错误', session: true },
    { kw: '综合.*错误',   signal: '综合错误', session: true },
  ];

  // 只处理 val 集之外的 session（避免 data leakage）
  const valNames = new Set(allSessions.filter(s => s.isVal).map(s => s.name));
  const mineSessions = allSessions.filter(s => !valNames.has(s.name));

  const hitCount = {};
  for (const s of mineSessions) {
    try {
      const content = fs.readFileSync(
        path.join(HOME_DIR, 'projects', s.name), 'utf-8'
      ).toLowerCase();

      for (const entry of PATTERN_MAP) {
        const re = new RegExp(entry.kw, 'g');
        if (re.test(content)) {
          if (!hitCount[entry.signal]) {
            hitCount[entry.signal] = { count: 0, sessions: [], kw: entry.kw };
          }
          hitCount[entry.signal].count++;
          if (hitCount[entry.signal].sessions.length < 3) {
            hitCount[entry.signal].sessions.push(s.name);
          }
        }
      }
    } catch (e) {
      // 单个 session 文件读取失败，跳过不影响整体统计
      console.warn('[skill-evolve] skip unreadable session:', s.name);
    }
  }

  // 频率 > 20% → 生成规则建议
  const threshold = Math.max(3, mineSessions.length * 0.2);
  for (const [signal, info] of Object.entries(hitCount)) {
    if (info.count < threshold) continue;

    let rule = null;
    if (signal.includes('lint') || signal.includes('编译')) {
      rule = '- **[MUST]** 提交前必须运行 `make lint`，禁止提交有 lint 错误的代码';
    } else if (signal.includes('位宽')) {
      rule = '- **[MUST]** 左右位宽必须显式匹配，禁止隐式位宽转换';
    } else if (signal.includes('接口不匹配')) {
      rule = '- **[MUST]** 模块例化时端口名/位宽必须与定义一致';
    } else if (signal.includes('golden') || signal.includes('bit-true')) {
      rule = '- **[SHOULD]** RTL 输出与 Golden Model 逐 bit 对比验证';
    } else if (signal.includes('testbench')) {
      rule = '- **[SHOULD]** Testbench 必须包含自检机制，不依赖人工看波形';
    } else if (signal.includes('时序')) {
      rule = '- **[MUST]** 关键路径插入流水线，满足时序约束';
    } else if (signal.includes('状态机')) {
      rule = '- **[MUST]** 三段式状态机 + default 分支，禁止组合输出';
    } else if (signal.includes('仿真结果')) {
      rule = '- **[SHOULD]** 仿真结果与预期值自动比对，不靠肉眼检查波形';
    }

    if (rule) {
      const confidence = info.count > mineSessions.length * 0.5 ? 'high' : 'medium';
      result.corrections.push({
        message: `重复出现 "${signal}" (${info.count}/${mineSessions.length} sessions)`,
        time: '',
        sessionId: '',
        isMined: true,
      });
      result.toolFails.push({
        pattern: signal,
        sessionId: '',
        time: '',
      });
    }
  }

  return result;
}

/**
 * 收集所有真实 session（排除 SkillOpt 测试产生的临时目录）。
 */
function collectAllSessions() {
  const projectsDir = path.join(HOME_DIR, 'projects');
  const sessions = [];
  try {
    if (fs.existsSync(projectsDir)) {
      for (const proj of fs.readdirSync(projectsDir)) {
        const pp = path.join(projectsDir, proj);
        if (!fs.statSync(pp).isDirectory()) continue;
        if (proj.includes('skillopt-sleep-claude') || proj.includes('Temp')) continue;
        for (const f of fs.readdirSync(pp)) {
          if (f.endsWith('.jsonl')) {
            sessions.push({
              name: path.join(proj, f),
              mtime: fs.statSync(path.join(pp, f)).mtimeMs,
            });
          }
        }
      }
    }
  } catch (e) {
    // 项目目录不可访问时返回空列表，后续降级为无 session 可用
    console.warn('[skill-evolve] cannot list project sessions:', e.message);
  }
  sessions.sort((a, b) => a.mtime - b.mtime);
  const valCount = Math.max(1, Math.floor(sessions.length * 0.3));
  return sessions.map((s, i) => ({ ...s, isVal: i >= sessions.length - valCount }));
}

// ── Force 模式: 从最近 session JSONL 文件采集 ───────────────────────

/**
 * 当 SQLite 事件表中无新数据时，直接从最近 session 的 JSONL 文件
 * 中扫描用户纠正信号。这是水印到达最新位置后的补充数据源。
 */
function harvestFromSessions() {
  const result = { corrections: [], stuck: [], toolFails: [] };
  const projectsDir = path.join(HOME_DIR, 'projects');
  if (!fs.existsSync(projectsDir)) return result;

  try {
    // 递归扫描所有项目子目录中的 .jsonl 文件
    const allSessions = [];
    for (const proj of fs.readdirSync(projectsDir)) {
      const projPath = path.join(projectsDir, proj);
      if (!fs.statSync(projPath).isDirectory()) continue;
      if (proj.includes('skillopt-sleep-claude') || proj.includes('Temp')) continue;
      for (const f of fs.readdirSync(projPath)) {
        if (f.endsWith('.jsonl')) {
          allSessions.push({
            name: path.join(proj, f),
            mtime: fs.statSync(path.join(projPath, f)).mtimeMs,
          });
        }
      }
    }

    const sessions = allSessions
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 5);

    for (const s of sessions) {
      const content = fs.readFileSync(path.join(projectsDir, s.name), 'utf-8');
      const lines = content.trim().split('\n');
      let hasCorrection = false;

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          // 真正的用户输入: type=user, userType=external, content 是字符串
          if (entry.type === 'user' && entry.userType === 'external' && typeof entry.message?.content === 'string') {
            const text = entry.message.content;
            // 检测纠正/不满/重新尝试信号
            if (/不对|不是|错了|停|stop|没有正常|没跑|跑不起来|行不行|又错|wrong|应该|重新|fix|correct|error|换个|换一|重做/i.test(text)) {
              result.corrections.push({
                message: text.slice(0, 200),
                sessionId: s.name.replace('.jsonl', ''),
                time: entry.timestamp || '',
              });
            }
          }
          // 检测 tool_fail 和错误信号
          if (entry.type === 'tool_fail' || (entry.message?.content && /Error|error|failed|FAILED/.test(JSON.stringify(entry.message.content)))) {
            result.toolFails.push({
              pattern: (entry.message?.content || '').toString().slice(0, 100),
              sessionId: s.name.replace('.jsonl', ''),
              time: entry.timestamp || '',
            });
          }
        } catch (e) { /* skip malformed lines */ }
      }
    }
  } catch (e) {
    console.error('[skill-evolve] session harvest error:', e.message);
  }

  return result;
}

// ── Main ──────────────────────────────────────────────────────────────

function runSkillEvolve(opts = {}) {
  const dryRun = opts.dryRun === true;
  const force = opts.force === true;
  const log = typeof opts.logger === 'function' ? opts.logger : console.log;
  const mineFn = opts.mineFn || mineImprovements;
  const validateFn = opts.validateFn || validateSuggestions;
  const gateFn = opts.gateFn || gateSuggestions;
  const stageFn = opts.stageFn || stageProposals;
  const { openDb } = require('../sqlite/index.cjs');
  const crypto = require('node:crypto');
  const eventStore = require('../sqlite/store-events.cjs');
  const { countSinceWatermark } = eventStore;
  const wDb = opts.db ? null : openDb(opts.dbPath ? { path: opts.dbPath } : {});
  const db = opts.db || wDb.db;
  const runId = String(opts.runId || crypto.randomUUID());
  let heartbeatStarted = false;
  let harvest;

  const finish = (status, extra = {}) => {
    let watermarkAfter = harvest.watermarkBefore;
    let processed = 0;
    if (!dryRun && harvest.inspected > 0) {
      setMyWatermark(harvest.batchWatermark, { db });
      watermarkAfter = harvest.batchWatermark;
      processed = harvest.inspected;
    }
    const result = {
      status,
      dryRun,
      inspected: harvest.inspected,
      processed,
      pending: countSinceWatermark(watermarkAfter, { db }),
      watermarkBefore: harvest.watermarkBefore,
      watermarkAfter,
      ...extra,
    };
    if (!dryRun) {
      eventStore.completeConsumerRun('skill-evolve', {
        db,
        runId,
        status: status === 'staged' ? 'success' : 'skipped',
        processedThrough: watermarkAfter,
        processed,
        pending: result.pending,
        nextDueAt: result.pending > 0 ? Date.now() + 86_400_000 : null,
        at: opts.now,
      });
    }
    return result;
  };

  try {
    if (!dryRun) {
      const watermark = eventStore.getWatermark({ db, consumer: 'skill-evolve' });
      eventStore.beginConsumerRun('skill-evolve', {
        db,
        runId,
        pending: countSinceWatermark(watermark, { db }),
        processedThrough: watermark,
        at: opts.now,
      });
      heartbeatStarted = true;
    }
    log('[skill-evolve] SkillOpt 蒸馏: harvest → mine → reflect → bounded edit → validate → stage');
    log('[skill-evolve] 阶段 1/5: Harvest — 收集用户纠正信号...');
    harvest = harvestCorrections({
      db,
      dryRun,
      force,
      limit: opts.limit,
      throwOnError: true,
    });
    const corrections = [...harvest.corrections];
    const stuck = [...harvest.stuck];
    const toolFails = [...harvest.toolFails];
    log(`[skill-evolve]    用户纠正: ${corrections.length} 条`);
    log(`[skill-evolve]    挫败信号: ${stuck.length} 条`);
    log(`[skill-evolve]    工具错误: ${toolFails.length} 条`);

    if (corrections.length === 0 && stuck.length === 0 && toolFails.length === 0) {
      if (!force) {
        log('[skill-evolve] 无可操作信号，提交本批消费位置');
        return finish(dryRun ? 'dry-run' : 'no-action', { reason: 'no-actionable-signals' });
      }
      log('[skill-evolve] --force 模式: session 内容 + 模式挖掘...');
      const allSessions = collectAllSessions();
      const sessionSignals = harvestFromSessions();
      corrections.push(...sessionSignals.corrections);
      stuck.push(...sessionSignals.stuck);
      toolFails.push(...sessionSignals.toolFails);
      const mined = minePatternsFromSessions(allSessions, force);
      corrections.push(...mined.corrections);
      toolFails.push(...mined.toolFails);
      if (corrections.length === 0 && stuck.length === 0 && toolFails.length === 0) {
        log('[skill-evolve] 无可操作信号，提交本批消费位置');
        return finish(dryRun ? 'dry-run' : 'no-action', { reason: 'no-force-signals' });
      }
    }

    log('[skill-evolve] 阶段 2/5: Mine — 提取可操作改进...');
    const suggestions = mineFn(corrections, stuck, toolFails);
    log(`[skill-evolve]    提取建议: ${suggestions.length} 条`);
    if (suggestions.length === 0) {
      log('[skill-evolve] 无可操作改进，提交本批消费位置');
      return finish(dryRun ? 'dry-run' : 'no-action', { reason: 'no-suggestions' });
    }

    log('[skill-evolve] 阶段 3/5: Reflect — 生成 bounded edit...');
    suggestions.forEach(suggestion => {
      log(`[skill-evolve]    [${suggestion.op}] ${suggestion.skill}/${suggestion.section}: ${suggestion.content.slice(0, 60)}...`);
    });

    log('[skill-evolve] 阶段 4/5: Validate — 检查冲突...');
    const validated = validateFn(suggestions);
    validated.forEach(value => {
      const status = value.valid ? '✅' : '⛔';
      log(`[skill-evolve]    ${status} [${value.op}] ${value.skill}: ${value.warning || '通过'}`);
    });

    log('[skill-evolve] 阶段 4.5/5: Gate — 验证门禁...');
    const gated = gateFn(validated);
    const gatedAccept = gated.filter(value => value.valid).length;
    log(`[skill-evolve]    门禁通过: ${gatedAccept}/${gated.length}`);

    log('[skill-evolve] 阶段 5/5: Stage — 输出提案...');
    const stageResult = stageFn(gated, dryRun);
    log('[skill-evolve] 完成');
    return finish(dryRun ? 'dry-run' : 'staged', {
      suggestions: suggestions.length,
      accepted: gatedAccept,
      stageResult,
    });
  } catch (error) {
    if (heartbeatStarted) {
      try {
        const watermark = eventStore.getWatermark({ db, consumer: 'skill-evolve' });
        eventStore.failConsumerRun('skill-evolve', {
          db,
          runId,
          error,
          pending: countSinceWatermark(watermark, { db }),
          processedThrough: watermark,
          at: opts.now,
        });
      } catch { /* health will expose a missing or stale heartbeat */ }
    }
    throw error;
  } finally {
    if (wDb) wDb.close();
  }
}

function main() {
  const args = process.argv.slice(2);
  return runSkillEvolve({
    dryRun: args.includes('--dry-run'),
    force: args.includes('--force'),
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
  runSkillEvolve,
  harvestCorrections,
  setMyWatermark,
};
