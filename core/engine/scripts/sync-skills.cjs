#!/usr/bin/env node
/**
 * core/engine/scripts/sync-skills.cjs — 技能单一真源 → 三宿主目录同步器（§3.5）。
 *
 * 真源（入库，唯一权威）：
 *   core/skills/ + packs/<pack>/skills/（fpga / office）
 * 投放目标（运行时发现位，单向渲染）：
 *   ~/.claude/skills/   Claude Code
 *   ~/.agents/skills/   Grok 原生扫描 + npx skills 生态
 *   ~/.codex/skills/    Codex
 * 宿主入口规则文件（随本脚本渲染 + --check）：
 *   根目录 CLAUDE.md / AGENTS.md —— 模板真源在 hosts/claude-code/（v2.1 修订 A3，
 *   宿主读取路径固定在仓库根）。
 *
 * 归一（§3.2 最小字段集，已获 Claude/Codex/Grok/DSH 四系统实证）：
 *   SKILL.md 投放时 frontmatter 归一为 name + description（+ 可选 version/license，
 *   固定顺序）；model/invoked_by/user_invocable/tools/tier 等私有字段留在真源
 *   由自家消费者（rule-loader / skill-evolve）使用，投放即剥离。
 *   同名技能多真源合并投放（core/skills/workflows + packs/fpga/skills/workflows
 *   → 目标 workflows/ 并集，文件名不得冲突）。
 *
 * 单向纪律（与 render-hook-settings / sync-workflow-mirror 同契约）：
 *   只从真源往目标投放——反向同步会把手工改镜像的错误"修"掉，那正是漂移
 *   检查要抓的东西。目标目录里**非本真源拥有**的技能目录（如 ~/.agents/skills/
 *   下的第三方技能）不触碰、不删除。
 *
 * 用法：
 *   node core/engine/scripts/sync-skills.cjs          # 投放（三目标 + 入口文件）
 *   node core/engine/scripts/sync-skills.cjs --check  # 只比对，任一漂移 exit 1
 *
 * 退出码：
 *   0 — 投放成功 / 无漂移
 *   1 — --check 发现任一目标或入口文件漂移
 *   2 — 真源缺失 / frontmatter 不可解析 / 同名合并冲突
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { HARNESS_ROOT } = require('./lib/harness-root.cjs');

// ── 真源收集 ───────────────────────────────────────────────────────────────

/**
 * 收集全部技能真源。
 * @param {string} root
 * @returns {Array<{ name: string, sources: string[] }>} 按名称分组（同名多真源=合并投放）
 */
function collectSkillSources(root = HARNESS_ROOT) {
  const roots = [
    path.join(root, 'core', 'skills'),
    ...fs.readdirSync(path.join(root, 'packs')).map((pack) => path.join(root, 'packs', pack, 'skills')),
  ];
  const byName = new Map();
  for (const dir of roots) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      if (name.startsWith('.')) continue;
      const full = path.join(dir, name);
      if (!fs.statSync(full).isDirectory()) continue;
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(full);
    }
  }
  return [...byName.entries()].map(([name, sources]) => ({ name, sources })).sort((a, b) => a.name.localeCompare(b.name));
}

/** 递归收集目录内全部文件的相对路径（正斜杠）。 */
function walkRel(dir, base = dir, acc = []) {
  for (const name of fs.readdirSync(dir).sort()) {
    if (name.startsWith('.')) continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walkRel(full, base, acc);
    else acc.push(path.relative(base, full).replace(/\\/g, '/'));
  }
  return acc.sort();
}

// ── frontmatter 归一 ───────────────────────────────────────────────────────

/** 归一后保留的最小字段（固定输出顺序）。私有字段一律剥离。 */
const MINIMAL_FIELDS = ['name', 'description', 'version', 'license'];

/**
 * 解析并归一 SKILL.md：frontmatter 只保留最小字段集，正文逐字节保留。
 * 无 frontmatter 或解析失败 → 原文返回（确定性兜底，漂移检查仍可比对）。
 * @param {string} text
 * @returns {string}
 */
function normalizeSkillMarkdown(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/);
  if (!match) return text;
  const fields = new Map();
  for (const line of match[1].split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf(':');
    if (idx <= 0) continue;
    fields.set(trimmed.slice(0, idx).trim(), trimmed.slice(idx + 1).trim());
  }
  if (!fields.get('name') || !fields.get('description')) return text;

  const lines = MINIMAL_FIELDS
    .filter((key) => fields.has(key))
    .map((key) => `${key}: ${fields.get(key)}`);
  const body = match[2] === undefined ? '' : match[2];
  return `---\n${lines.join('\n')}\n---${body.startsWith('\n') || body === '' ? body : `\n${body}`}`;
}

/**
 * 渲染单个技能文件：SKILL.md 归一，其余逐字节。
 * @param {string} sourceFile
 * @returns {string}
 */
function renderSkillFile(sourceFile) {
  const raw = fs.readFileSync(sourceFile, 'utf8');
  if (path.basename(sourceFile) === 'SKILL.md') return normalizeSkillMarkdown(raw);
  return raw;
}

/**
 * 渲染一个技能（同名多真源=合并）。
 * @param {{ name: string, sources: string[] }} skill
 * @returns {Map<string, string>} rel 路径 → 渲染内容
 */
function renderSkill(skill) {
  const rendered = new Map();
  for (const source of skill.sources) {
    for (const rel of walkRel(source)) {
      if (rendered.has(rel)) {
        throw Object.assign(new Error(`同名合并冲突: ${skill.name}/${rel}`), { exitCode: 2 });
      }
      rendered.set(rel, renderSkillFile(path.join(source, rel)));
    }
  }
  return rendered;
}

// ── 投放 / 漂移检查 ────────────────────────────────────────────────────────

/** 三宿主目标目录（可用 env 覆盖，供沙箱测试）。 */
function defaultTargets(home = os.homedir(), env = process.env) {
  return [
    { host: 'claude-code', dir: env.CLAUDE_SKILLS_DIR || path.join(home, '.claude', 'skills') },
    { host: 'grok', dir: env.AGENTS_SKILLS_DIR || path.join(home, '.agents', 'skills') },
    { host: 'codex', dir: env.CODEX_SKILLS_DIR || path.join(home, '.codex', 'skills') },
  ];
}

function targetInitialized(dir) {
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir).some((name) => !name.startsWith('.'));
}

/**
 * 投放一个目标目录。目标里我们拥有的技能目录整体重建（确定性镜像）；
 * 非真源拥有的目录不触碰。
 * @param {string} dir
 * @param {Array} skills collectSkillSources() 结果
 * @param {object} [opts]
 */
function deployTarget(dir, skills, opts = {}) {
  const report = [];
  fs.mkdirSync(dir, { recursive: true });
  for (const skill of skills) {
    const rendered = renderSkill(skill);
    const skillDir = path.join(dir, skill.name);
    fs.rmSync(skillDir, { recursive: true, force: true });
    for (const [rel, content] of rendered) {
      const dst = path.join(skillDir, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      // 原子替换写：宿主目标可能是与真源共享 inode 的历史硬链接（~/.agents 手工
      // 维护层实测有此陷阱，Windows stat 的 nlink=1 是误报、须直比 ino 才可见）——
      // 直接 writeFileSync 会截断共享 inode 篡改真源；temp+rename 只替换目录项，
      // 旧 inode 在真源侧的链接原样保留。
      const tmp = `${dst}.sync-tmp`;
      fs.writeFileSync(tmp, content);
      fs.renameSync(tmp, dst);
    }
    report.push(`${skill.name}(${rendered.size} 文件)`);
  }
  if (opts.quiet !== true) {
    process.stdout.write(`[sync-skills] 已投放 ${dir} — ${report.length} 技能: ${report.join(', ')}\n`);
  }
  return { dir, count: report.length };
}

/**
 * 比对一个目标目录与渲染结果。
 * 目标未初始化（不存在/空）→ 跳过（新机器首投前不算漂移）。
 * @returns {{ host: string, dir: string, skip: boolean, drift: string[] }}
 */
function checkTarget(host, dir, skills) {
  if (!targetInitialized(dir)) {
    return { host, dir, skip: true, drift: [] };
  }
  const drift = [];
  for (const skill of skills) {
    const rendered = renderSkill(skill);
    const skillDir = path.join(dir, skill.name);
    if (!fs.existsSync(skillDir)) {
      drift.push(`${skill.name}: 目标缺失`);
      continue;
    }
    for (const [rel, content] of rendered) {
      const dst = path.join(skillDir, rel);
      let actual = null;
      try { actual = fs.readFileSync(dst, 'utf8'); } catch { /* 缺失 */ }
      if (actual === null) drift.push(`${skill.name}/${rel}: 缺失`);
      else if (actual !== content) drift.push(`${skill.name}/${rel}: 内容不一致`);
    }
    for (const rel of walkRel(skillDir)) {
      if (!rendered.has(rel)) drift.push(`${skill.name}/${rel}: 多余文件（真源已无）`);
    }
  }
  return { host, dir, skip: false, drift };
}

// ── 宿主入口规则文件（根 CLAUDE.md / AGENTS.md）───────────────────────────

function entryFiles(root = HARNESS_ROOT) {
  return [
    { template: path.join(root, 'hosts', 'claude-code', 'CLAUDE.md'), product: path.join(root, 'CLAUDE.md') },
    { template: path.join(root, 'hosts', 'claude-code', 'AGENTS.md'), product: path.join(root, 'AGENTS.md') },
  ];
}

function deployEntryFiles(root = HARNESS_ROOT) {
  for (const { template, product } of entryFiles(root)) {
    fs.copyFileSync(template, product);
    process.stdout.write(`[sync-skills] 已渲染 ${product}\n`);
  }
}

function checkEntryFiles(root = HARNESS_ROOT) {
  const drift = [];
  for (const { template, product } of entryFiles(root)) {
    if (!fs.existsSync(product)) { drift.push(`${path.basename(product)}: 渲染产物缺失`); continue; }
    if (fs.readFileSync(product, 'utf8') !== fs.readFileSync(template, 'utf8')) {
      drift.push(`${path.basename(product)}: 与模板漂移`);
    }
  }
  return drift;
}

// ── CLI ────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  try {
    const skills = collectSkillSources();
    if (!skills.length) {
      throw Object.assign(new Error('真源为空：core/skills/ 与 packs/*/skills/ 均无技能'), { exitCode: 2 });
    }

    if (checkOnly) {
      const failures = [];
      let skipped = 0;
      for (const target of defaultTargets()) {
        const result = checkTarget(target.host, target.dir, skills);
        if (result.skip) { skipped++; continue; }
        if (result.drift.length) failures.push(`[${target.host} ${target.dir}] ${result.drift.slice(0, 5).join('；')}${result.drift.length > 5 ? ` 等 ${result.drift.length} 处` : ''}`);
      }
      failures.push(...checkEntryFiles().map((reason) => `[入口文件] ${reason}`));
      if (failures.length) {
        for (const failure of failures) process.stderr.write(`[sync-skills] ✖ 漂移: ${failure}\n`);
        process.stderr.write('[sync-skills]   真源是权威声明。跑 node core/engine/scripts/sync-skills.cjs 重新投放\n');
        return 1;
      }
      process.stdout.write(`[sync-skills] ✓ ${defaultTargets().length - skipped} 个宿主目标与真源一致${skipped ? `（${skipped} 个未初始化目标跳过）` : ''}；入口文件与模板一致 (${skills.length} 技能)\n`);
      return 0;
    }

    for (const target of defaultTargets()) deployTarget(target.dir, skills);
    deployEntryFiles();
    return 0;
  } catch (err) {
    process.stderr.write(`[sync-skills] ${err.message}\n`);
    return err.exitCode || 2;
  }
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  MINIMAL_FIELDS,
  checkEntryFiles,
  checkTarget,
  collectSkillSources,
  defaultTargets,
  deployEntryFiles,
  deployTarget,
  entryFiles,
  normalizeSkillMarkdown,
  renderSkill,
  renderSkillFile,
};
