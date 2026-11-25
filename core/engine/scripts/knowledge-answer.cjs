'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { kbPath } = require('../config.cjs');
const semantic = require('./semantic-search.cjs');
const { isInactiveMemoryContent } = require('./lib/memory-file-policy.cjs');

const packageRoot = path.resolve(__dirname, '../../..');
const missing = answer => ({ status: 'insufficient_evidence', answer, citations: [] });
const tokens = text => [...new Set(semantic.tokenize(text).filter(t => t.length > 1))];
const conditions = /[a-z][a-z0-9_]*-\d+|[+-]?\d+(?:\.\d+)?\s*(?:°c|℃|mhz|ghz|dbm?|ns|ms|mv|v)/gi;
const metrics = /\b(?:ber|evm|wns|fmax|snr|mse|lut|bram|dsp)\b|误码率|吞吐率|功耗|时延/gi;
function terms(text, pattern) {
  return (text.match(pattern) || []).map(t => t.toLowerCase().replace(/\s+/g, ''));
}

function inside(root, file) {
  const rel = path.relative(root, file);
  return !!rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

function source(home, file) {
  if (!inside(home, file) || !fs.existsSync(file)) return null;
  const real = fs.realpathSync(file);
  if (!inside(home, real) || !fs.statSync(real).isFile()) return null;
  for (let dir = path.dirname(real); inside(home, dir); dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '_SUPERSEDED.md'))) return null;
  }
  const text = fs.readFileSync(real, 'utf8').replace(/\r\n/g, '\n');
  if (isInactiveMemoryContent(text)) return null;
  return { file: path.relative(home, real).split(path.sep).join('/'), text, lines: text.split('\n') };
}

function cite(doc, i) {
  return { file: doc.file, line: i + 1, quote: doc.lines[i].trim() };
}

function assetEvidence(home, assets, query, hint, measurement) {
  const dir = path.join(assets, 'cbb');
  const words = query.toLowerCase().match(/[a-z0-9_]+/g) || [];
  const ids = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory()).map(e => e.name) : [];
  const exact = ids.filter(id => words.includes(id));
  const matched = exact.length ? exact : ids.filter(id => id.split('_').some(word => words.includes(word)));
  let choices = matched;
  if (hint) choices = ids.filter(id => id === hint && (!matched.length || matched.includes(id)));
  if (choices.length !== 1) return missing(measurement ? '缺少可核对的对应实测记录。' : '请明确要核对的资产 ID。');
  return signedScope(home, assets, choices[0], query, measurement, new Set());
}

function signedScope(home, assets, id, query, measurement, visited) {
  if (typeof id !== 'string' || !/^[\w-]+$/.test(id) || visited.has(id)) return missing('资产替代关系无效。');
  visited.add(id);
  const dir = path.join(assets, 'cbb');
  const manifest = source(home, path.join(dir, id, 'manifest.json'));
  if (!manifest) return missing('缺少当前资产清单。');
  const m = JSON.parse(manifest.text);
  if (m.asset_uid !== id || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(m.version)) return missing('资产身份或版本无法核对。');
  if (m.superseded_by) {
    const line = manifest.lines.findIndex(l => /"superseded_by"\s*:/.test(l) && l.includes(JSON.stringify(m.superseded_by)));
    if (line < 0) return missing('无法定位资产替代指针。');
    const next = signedScope(home, assets, m.superseded_by, query, measurement, visited);
    return { ...next, answer: id + ' 已被取代，后继资产 ' + m.superseded_by + '。\n' + next.answer,
      citations: [cite(manifest, line), ...next.citations] };
  }
  const seal = source(home, path.join(assets, 'evidence', id, m.version, 'SNAPSHOT.json'));
  const s = seal && JSON.parse(seal.text);
  const digest = crypto.createHash('sha256').update(manifest.text).digest('hex');
  if (s?.asset_uid !== id || s.version !== m.version || s.manifest_sha256 !== digest ||
      s.gate_summary?.cleared_level !== 'certified' || s.gate_summary.asset_uid !== id || s.gate_summary.blocking_at ||
      m.maturity?.level !== 'certified' ||
      !m.signoff?.by || !m.signoff.at || !Array.isArray(m.signoff.scope) || !m.signoff.scope.length) {
    return missing('当前清单与该版本的封存签核证据无法核对。');
  }
  let statements = [m.protocol_anchor?.profile, m.protocol_anchor?.scope, ...m.signoff.scope].filter(Boolean);
  if (measurement) {
    const requestedMetrics = terms(query, metrics);
    const requestedConditions = terms(query, conditions);
    statements = m.signoff.scope.filter(line => /(?:实测|measured|上板)/i.test(line) &&
      !/估算|目标|预计|尚未|未测|未上板|未实测|待测|模拟值|estimated|target|not measured/i.test(line) &&
      requestedMetrics.length && requestedMetrics.every(metric =>
        new RegExp(metric + '\\s*(?:[=:：约为]|为)?\\s*[+-]?\\d', 'i').test(line)) &&
      requestedConditions.every(t => terms(line, conditions).includes(t)));
    if (!statements.length) return missing('当前签核范围内缺少与所问条件和指标匹配的实测记录。');
  }
  const citations = [];
  for (const [doc, value] of [[manifest, m.version], [seal, digest], ...statements.map(line => [manifest, line])]) {
    const index = doc.lines.findIndex(line => line.includes(JSON.stringify(value)));
    if (index < 0) return missing('签核字段未能定位到可引用的原文行。');
    citations.push(cite(doc, index));
  }
  return { status: 'supported', asset: id, version: m.version, answer: [id + '@' + m.version, ...statements].join('\n'), citations };
}

function routes(home, kb, query, pattern) {
  const tags = source(home, path.join(kb, 'TAG_INDEX.md'));
  const lower = query.toLowerCase();
  const matches = [...(tags?.text || '').matchAll(/\[([^\]\n]+)\]\(([^)\n]+)\)/g)]
    .filter(([, , target]) => pattern.test(target.split('#')[0]))
    .map(([, label, target]) => ({ target, score: label.toLowerCase().split(/\s+/)
      .reduce((n, word) => n + (lower.includes(word) ? word.length : 0), 0) }))
    .filter(r => r.score).sort((a, b) => b.score - a.score);
  return matches.filter(r => r.score === matches[0].score).map(r => {
    const [file, anchor] = r.target.split('#');
    return { file: path.resolve(kb, file), anchor };
  });
}

function answer(question, { home = packageRoot, asset } = {}) {
  const query = typeof question === 'string' ? question.trim() : '';
  if (!query) return missing('请提供知识库问题。');
  home = fs.realpathSync(home);
  const kb = kbPath(home);
  let warning;
  try { semantic.ensureIndex(home); } catch (error) { warning = error.message; }
  function lookup() {
    const measurement = /实测|上板|measured|bench measurement/i.test(query) ||
      (terms(query, conditions).length > 0 && terms(query, metrics).length > 0);
    if (measurement || asset || /签核|复用|认证|验收|综合包络|独立综合|量产|直接用|验证过|能否投用|sign.?off|reuse|certif/i.test(query)) {
      return assetEvidence(home, path.dirname(kb), query, asset, measurement);
    }
    if (/脚本|联仿|cosim|\.m\b|script/i.test(query)) {
      const files = routes(home, kb, query, /\.(m|py|tcl|sh)$/i);
      const script = files.length === 1 && source(home, files[0].file);
      if (!script) return missing('无法定位唯一且存在的入口脚本，请明确模块。');
      const i = script.lines.findIndex(line => line.trim());
      if (i < 0) return missing('入口脚本为空。');
      return { status: 'supported', answer: script.file, citations: [cite(script, i)] };
    }
    const files = routes(home, kb, query, /\.md$/i);
    if (!warning) {
      const result = semantic.querySemantic(query, { home, topK: 8 });
      for (const r of result.results) {
        const file = path.resolve(home, r.path);
        if (inside(kb, file)) files.push({ file });
      }
    }
    const queryTerms = tokens(query);
    for (const { file, anchor } of files) {
      const doc = source(home, file);
      if (!doc) continue;
      if (anchor) {
        const start = doc.lines.findIndex(line => /^#+ /.test(line) &&
          line.replace(/^#+\s+/, '').trim().toLowerCase().replace(/\s+/g, '-') === anchor);
        if (start < 0) continue;
        const citations = [];
        for (let i = start; i < doc.lines.length && i < start + 20; i++) {
          const line = doc.lines[i].trim();
          if (i > start && /^(?:#|---)/.test(line)) break;
          if (line && !/^\|[:|\s-]+$/.test(line)) citations.push(cite(doc, i));
        }
        return { status: 'references', answer: citations.map(c => c.quote).join('\n'), citations };
      }
      const bodyStart = doc.lines[0] === '---' ? doc.lines.indexOf('---', 1) + 1 : 0;
      const passages = doc.lines.map((line, i) => ({ i, score: i < bodyStart || line.trim().length < 8 ? 0 :
        queryTerms.reduce((n, term) => n + (line.toLowerCase().includes(term) ? term.length : 0), 0) }))
        .filter(p => p.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
      if (passages.length) {
        const citations = passages.map(p => cite(doc, p.i));
        return { status: 'references', answer: citations.map(c => c.quote).join('\n'), citations };
      }
    }
    return missing('未找到可定位的相关原文。');
  }
  try {
    const result = lookup();
    if (warning) result.indexWarning = warning;
    return result;
  } catch (error) { return missing('证据读取失败：' + error.message); }
}

module.exports = { answer };
if (require.main === module) {
  const [, , query, flag, asset] = process.argv;
  console.log(JSON.stringify(answer(query, { asset: flag === '--asset' ? asset : undefined }), null, 2));
}
