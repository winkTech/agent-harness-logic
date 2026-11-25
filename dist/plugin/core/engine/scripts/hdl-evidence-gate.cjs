#!/usr/bin/env node
'use strict';

/**
 * core/engine/scripts/hdl-evidence-gate.cjs — HDL 工作流确定性证据门禁。
 *
 * 背景: hdl-coding-dag-workflow 的 Phase 1b/4/4.5 需要读磁盘证据
 * (architecture.yaml / 02_sim/check_results/*.json)。Workflow 运行时没有
 * 文件系统 API —— 旧版工作流指望一个从未存在的 globalThis.workflowFs 桥,
 * 导致证据门禁在生产路径上从未运行过。本脚本把证据判定移出工作流:
 * 工作流派一个证据 agent 执行本脚本, 判定由这里的确定性代码完成,
 * agent 只负责把输出 JSON 原样带回。
 *
 * 用法:
 *   node core/engine/scripts/hdl-evidence-gate.cjs --project-root <dir> --arch
 *   node core/engine/scripts/hdl-evidence-gate.cjs --project-root <dir> --modules a,b,c
 *   node core/engine/scripts/hdl-evidence-gate.cjs --project-root <dir> --fixed-point --with-baseline --modules a,b
 *   node core/engine/scripts/hdl-evidence-gate.cjs --project-root <dir> --rtl-ready --modules a,b
 *   node core/engine/scripts/hdl-evidence-gate.cjs --project-root <dir> --arch --modules a,b,c
 *
 * 输出契约 (供工作流 schema 校验):
 *   stdout 第一段: 单个 JSON 对象 {gate, version, ok, arch?, modules?, failures}
 *   stdout 末行:   RESULT: PASS 或 RESULT: FAIL   (对齐 verification-gate 正面证据判据)
 *   退出码:        0=PASS, 1=FAIL, 2=用法错误
 *
 * 架构和 Phase 4.5 的判定规则:
 *   - arch: 06_doc/architecture.yaml 存在, 且含 modules/pipeline_stages/
 *     fsm_states/bit_width/latency 字段 (缺字段 = warning, 不 FAIL —— 与旧行为一致)
 *   - modules: 02_sim/check_results/<mod>.json 每个都存在、可解析、
 *     status === 'PASS' 且 compared_points > 0
 */

const fs = require('node:fs');
const path = require('node:path');
const { projectFile, checkFixedPoint, checkVerification } = require('./lib/hdl-phase-readiness.cjs');

// Phase 2.4：防写开关双名兼容（宿主名映射集中在 io/env.cjs，本文件不出现宿主词）。
const { envValue } = require('./io/env.cjs');
function envFlag(name) {
  const v = envValue(process.env, name);
  return v === '1' || v === 'true';
}

// 进程启动 (模块加载) 时刻 —— duration_sec 唯一可信的计时起点。
// 本脚本是工作流真实调用的进程, 加载→证据检查→落库的 elapsed 全程可测。
const PROCESS_STARTED_AT = Date.now();

// Windows 工具链 (尤其 PowerShell 5.1 的 -Encoding utf8) 写文件带 BOM,
// JSON.parse 会在 ﻿ 上直接失败 —— 证据文件本身没问题却被判 FAIL。
function readTextNoBom(p) {
  return fs.readFileSync(p, 'utf8').replace(/^﻿/, '');
}

const ARCH_REQUIRED_FIELDS = ['modules', 'pipeline_stages', 'fsm_states', 'bit_width', 'latency'];

function parseArgs(argv) {
  const out = { projectRoot: '.', arch: false, modules: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--project-root') out.projectRoot = argv[++i] || '.';
    else if (a === '--arch') out.arch = true;
    else if (a === '--golden') out.golden = true;
    else if (a === '--checklist') {
      out.checklist = argv[++i];
      if (!['p1a', 'p1b'].includes(out.checklist)) return { error: 'expected --checklist p1a or p1b' };
    }
    else if (a === '--rtl-ready') out.rtlReady = true;
    else if (a === '--fixed-point') out.fixedPoint = true;
    else if (a === '--with-baseline') out.withBaseline = true;
    else if (a === '--hard-limit') {
      const pair = /^(DSP|LUT|BRAM)=(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.exec(argv[++i] || '');
      if (!pair || !Number.isFinite(Number(pair[2]))) return { error: 'expected --hard-limit DSP|LUT|BRAM=number' };
      out.hardLimits ??= {};
      if (Object.hasOwn(out.hardLimits, pair[1])) return { error: 'duplicate hard limit for ' + pair[1] };
      out.hardLimits[pair[1]] = Number(pair[2]);
    }
    else if (a === '--lite') out.lite = true;
    else if (a === '--modules') out.modules = String(argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--vivado-summary') {
      const next = argv[i + 1];
      out.vivadoSummary = (next && !next.startsWith('--')) ? argv[++i] : '03_impl/flow_summary.json';
    }
    else if (a === '--min-wns') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v)) return { error: '--min-wns requires a finite number' };
      out.minWns = v;
    }
    else if (a === '--min-whs') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v)) return { error: '--min-whs requires a finite number' };
      out.minWhs = v;
    }
    else if (a === '--max-latches') {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < 0) return { error: '--max-latches requires a non-negative integer' };
      out.maxLatches = v;
    }
    else if (a === '--max-cdc-critical') {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < 0) return { error: '--max-cdc-critical requires a non-negative integer' };
      out.maxCdcCritical = v;
    }
    else if (a === '--json') { /* 输出本就是 JSON, 兼容旗标 */ }
    else return { error: `unknown argument: ${a}` };
  }
  if (out.lite && (!out.rtlReady || out.fixedPoint)) return { error: '--lite applies only to --rtl-ready' };
  if (out.withBaseline && (out.lite || (!out.fixedPoint && !out.rtlReady))) return { error: '--with-baseline requires full phase readiness' };
  if (out.hardLimits && (out.lite || (!out.fixedPoint && !out.rtlReady))) return { error: 'hard fixed-point limits require full phase readiness' };
  if ((out.rtlReady || out.fixedPoint) && (!out.modules.length || out.modules.some(mod => !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(mod)))) {
    return { error: 'phase readiness requires --modules with explicit HDL identifiers' };
  }
  if (!out.arch && !out.golden && !out.checklist && !out.vivadoSummary && out.modules.length === 0) {
    return { error: 'nothing to check: pass --arch, --vivado-summary and/or --modules a,b,c' };
  }
  return out;
}

function checklistInventory(phase) {
  if (!['p1a', 'p1b'].includes(phase)) throw new Error('unknown checklist');
  const { kbPath } = require('../config.cjs');
  const file = path.join(kbPath(path.resolve(__dirname, '../../..')), 'primary', 'architecture-patterns', 'gate-checklist-' + phase + '.md');
  const groups = { must: [], should: [], redline: [] };
  const seen = new Set();
  let redline = false;
  for (const line of readTextNoBom(file).split(/\r?\n/)) {
    if (/^##\s/.test(line)) redline = line.includes('红线');
    const row = /^\|\s*(R?\d+)\s*\|/.exec(line);
    if (!row) continue;
    const grade = /\|\s*(MUST|SHOULD|🔴\s*\*\*红线\*\*)\s*\|/.exec(line);
    if (!grade || seen.has(row[1])) throw new Error('invalid or duplicate checklist item ' + row[1]);
    seen.add(row[1]);
    const group = redline || grade[1].includes('红线') ? 'redline' : grade[1].toLowerCase();
    groups[group].push(row[1]);
  }
  if (!groups.must.length || !groups.redline.length) throw new Error('incomplete checklist: ' + file);
  const counts = Object.fromEntries(Object.entries(groups).map(([name, ids]) => [name, ids.length]));
  return { phase, groups, counts, total: seen.size };
}

function checkGolden(root) {
  const receipt = 'var/workflow/golden-preflight.json';
  const failures = [];
  let data;
  try {
    const file = projectFile(root, receipt);
    if (!file) throw new Error('missing receipt');
    data = JSON.parse(readTextNoBom(file));
    if (!data || typeof data !== 'object') throw new Error('invalid receipt');
  } catch (err) {
    return { failures: [receipt + ': ' + err.message] };
  }
  const { entry, entryLog, exitCode, cases, tools } = data;
  const original = projectFile(root, entry);
  const excluded = new Set([null, projectFile(root, receipt), original]);
  const hasLog = file => !excluded.has(projectFile(root, file));
  if (!original || exitCode !== 0 || !hasLog(entryLog)) failures.push('original entry did not produce a successful run with a log');
  if (original && data.entrySha256 !== require('node:crypto').createHash('sha256').update(fs.readFileSync(original)).digest('hex')) {
    failures.push('entry digest missing or changed since baseline run');
  }
  if (!Array.isArray(cases) || !cases.length) failures.push('missing baseline cases');
  const passedCases = [];
  for (const item of Array.isArray(cases) ? cases : []) {
    if (item && (!Array.isArray(item.oracleInputs) || item.oracleInputs.length)) {
      failures.push('missing input provenance or externally supplied ground truth: ' + item.name);
      continue;
    }
    if (!item || typeof item.name !== 'string' || !item.name.trim() || passedCases.includes(item.name)
        || item.source !== 'normal' || !Number.isSafeInteger(item.compared) || item.compared <= 0
        || typeof item.criterion !== 'string' || !item.criterion.trim() || item.passed !== true || !hasLog(item.log)) {
      failures.push('invalid normal-path comparison: ' + (item?.name || '(unnamed)'));
    } else passedCases.push(item.name);
  }
  const passedTools = [];
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (tool && typeof tool.name === 'string' && tool.exitCode === 0 && hasLog(tool.log)) passedTools.push(tool.name);
  }
  const scopePath = 'var/workflow/golden-scope.json';
  const checkedLimits = [];
  try {
    const file = projectFile(root, scopePath);
    if (!file) throw new Error('missing scope');
    const scope = JSON.parse(readTextNoBom(file));
    if (typeof scope.entry !== 'string' || scope.entry !== entry) failures.push('original entry differs from scope');
    if (!Array.isArray(scope.cases) || !scope.cases.length || !Array.isArray(scope.tools ?? [])) {
      throw new Error('expected nonempty cases and optional tools arrays');
    }
    for (const name of scope.cases) if (!passedCases.includes(name)) failures.push('missing qualified case: ' + name);
    for (const name of scope.tools ?? []) if (!passedTools.includes(name)) failures.push('missing tool smoke: ' + name);
    if (!Array.isArray(scope.limits ?? [])) throw new Error('limits must be an array');
    for (const limit of scope.limits ?? []) {
      if (!limit || !scope.cases.includes(limit.case) || typeof limit.metric !== 'string' || !limit.metric.trim()
          || (limit.min === undefined && limit.max === undefined)
          || (limit.min !== undefined && !Number.isFinite(limit.min)) || (limit.max !== undefined && !Number.isFinite(limit.max))
          || limit.min > limit.max) throw new Error('invalid per-case acceptance limit');
      const value = (Array.isArray(cases) ? cases : []).find(item => item?.name === limit.case)?.metrics?.[limit.metric];
      if (!Number.isFinite(value) || value < limit.min || value > limit.max) {
        failures.push(`${limit.case}: measured ${limit.metric}=${value ?? 'missing'} outside requested limits`);
      } else checkedLimits.push({ case: limit.case, metric: limit.metric, min: limit.min, max: limit.max });
    }
  } catch (err) { failures.push(scopePath + ': ' + err.message); }
  return { entry, passedCases, passedTools, checkedLimits, failures };
}

function rtlPrerequisites(root, modules) {
  const files = ['06_doc/architecture.yaml', '06_doc/verification_strategy.md'];
  for (const mod of modules) files.push(
    `02_sim/${mod}/tb_${mod}.sv`, `02_sim/check_${mod}.py`, `02_sim/tv/${mod}_tv.txt`
  );
  return files.filter(file => !projectFile(root, file));
}

function checkArch(projectRoot) {
  const archPath = path.join(projectRoot, '06_doc', 'architecture.yaml');
  const result = { path: archPath.replace(/\\/g, '/'), exists: false, missingFields: [], warnings: [] };
  if (!fs.existsSync(archPath)) {
    result.reason = 'architecture.yaml not found — P1b did not produce the microarchitecture contract';
    return { ok: false, result };
  }
  result.exists = true;
  const stat = fs.statSync(archPath);
  result.bytes = stat.size;
  result.mtime = stat.mtime.toISOString();
  const content = readTextNoBom(archPath);
  result.missingFields = ARCH_REQUIRED_FIELDS.filter(f => !content.includes(f));
  if (result.missingFields.length > 0) {
    // 与旧内联行为一致: 缺字段仅告警, 不阻断 (审查时补齐)
    result.warnings.push(`architecture.yaml missing fields: ${result.missingFields.join(', ')}`);
  }
  return { ok: true, result };
}

function checkModule(projectRoot, mod) {
  const jsonPath = path.join(projectRoot, '02_sim', 'check_results', `${mod}.json`);
  const entry = { module: mod, path: jsonPath.replace(/\\/g, '/'), pass: false };
  if (!fs.existsSync(jsonPath)) {
    entry.reason = 'evidence JSON not found — check script was never run for this module';
    return entry;
  }
  const stat = fs.statSync(jsonPath);
  entry.bytes = stat.size;
  entry.mtime = stat.mtime.toISOString();
  let data;
  try {
    data = JSON.parse(readTextNoBom(jsonPath));
  } catch (e) {
    entry.reason = `evidence JSON unparseable: ${e.message}`;
    return entry;
  }
  if (data.status !== 'PASS') {
    entry.reason = `status=${data.status ?? 'MISSING'}, first_fail_at=${data.first_fail_at ?? 'N/A'}`;
    return entry;
  }
  const points = Number(data.compared_points || 0);
  if (!(points > 0)) {
    entry.reason = `compared_points=${data.compared_points ?? 0} — comparison script likely never executed`;
    return entry;
  }
  entry.pass = true;
  entry.compared_points = points;
  entry.max_error_lsb = data.max_error_lsb ?? 0;
  return entry;
}

/**
 * 结构化硬件指标门禁（M5）：消费 vivado-flow 的 flow_summary.json。
 * 支持嵌套结构（timing.wns_ns / methodology.inferred_latches / cdc.critical_violations）
 * 以及扁平字段（wns / whs / inferred_latches / cdc_critical）。
 */
function checkVivadoSummary(projectRoot, summaryRelOrAbs = '03_impl/flow_summary.json', thresholds = {}) {
  const minWns = thresholds.minWns ?? 0;
  const minWhs = thresholds.minWhs ?? 0;
  const maxLatches = thresholds.maxLatches ?? 0;
  const maxCdcCritical = thresholds.maxCdcCritical ?? 0;
  const fullPath = path.isAbsolute(summaryRelOrAbs)
    ? path.resolve(summaryRelOrAbs)
    : path.resolve(projectRoot, summaryRelOrAbs);
  const result = {
    path: fullPath.replace(/\\/g, '/'),
    exists: false,
    pass: false,
    thresholds: { minWns, minWhs, maxLatches, maxCdcCritical },
    metrics: {},
    failures: [],
  };
  if (!fs.existsSync(fullPath)) {
    result.failures.push(`vivado summary not found: ${summaryRelOrAbs}`);
    return result;
  }
  result.exists = true;
  let data;
  try {
    data = JSON.parse(readTextNoBom(fullPath));
    if (!data || typeof data !== 'object') throw new Error('root must be a JSON object');
  } catch (err) {
    result.failures.push(`vivado summary unparseable: ${err.message}`);
    return result;
  }

  const pickNum = (...candidates) => {
    for (const v of candidates) {
      if (v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v))) return Number(v);
    }
    return null;
  };
  const status = String(data.status || '').toUpperCase();
  const wns = pickNum(data.timing?.wns_ns, data.timing?.wns, data.wns_ns, data.wns);
  const whs = pickNum(data.timing?.whs_ns, data.timing?.whs, data.whs_ns, data.whs);
  const latches = pickNum(
    data.methodology?.inferred_latches,
    data.synthesis?.inferred_latches,
    data.inferred_latches,
    data.latches,
  );
  const cdcCritical = pickNum(
    data.cdc?.critical_violations,
    data.cdc?.critical,
    data.methodology?.cdc_critical,
    data.cdc_critical,
  );

  result.metrics = { status: status || null, wns, whs, inferred_latches: latches, cdc_critical: cdcCritical };
  if (status === 'FAIL' || status === 'ERROR') {
    result.failures.push(`vivado flow status=${status}`);
  }
  if (wns === null) result.failures.push('vivado summary missing numeric WNS');
  else if (wns < minWns) result.failures.push(`WNS ${wns} ns < threshold ${minWns} ns (timing violation)`);
  if (whs !== null && whs < minWhs) result.failures.push(`WHS ${whs} ns < threshold ${minWhs} ns (hold violation)`);
  if (latches !== null && latches > maxLatches) result.failures.push(`inferred latches ${latches} > limit ${maxLatches}`);
  if (cdcCritical !== null && cdcCritical > maxCdcCritical) result.failures.push(`CDC critical violations ${cdcCritical} > limit ${maxCdcCritical}`);

  result.pass = result.failures.length === 0;
  return result;
}

/**
 * DAG 阶段级交付落库 (D1, 2026-07-30)。
 *
 * 为什么在这里而不在工作流里: workflow 脚本跑在没有 Node API 的沙箱, 不能直接
 * 调 delivery-tracker —— 这正是 P1 留下的缺口。本脚本是工作流**真实调用**的
 * 确定性证据门禁, 它同时知道阶段 (--arch / --modules) 与判定, 是唯一自然的
 * 落库点。fail-open: 落库失败绝不影响门禁判定 (判定是本脚本的主职责)。
 */
function recordPhaseDelivery(report, opts, deps = {}) {
  if (envFlag('HARNESS_NO_PERSIST')
    || envFlag('HARNESS_VERIFY_READONLY')
    || envFlag('HARNESS_NO_DIAGNOSTIC_WRITES')) return { skipped: true };
  try {
    const { recordDelivery } = deps.deliveryTracker || require('./delivery-tracker.cjs');
    const phase = opts.arch && opts.modules.length > 0 ? 'P1b+P4.5'
      : opts.arch ? 'P1b' : 'P4.5';
    const recorded = recordDelivery({
      workflow: 'hdl-coding-dag-workflow',
      phase,
      status: report.ok ? 'pass' : 'fail',
      modules: opts.modules.length,
      // duration_sec: 进程加载到落库的真实 elapsed (秒), 覆盖全部证据检查耗时。
      // retry_count 留 0: 本门禁没有重试路径, 无真实计数可记, 不编造;
      // 若上游工作流引入重试, 应在真实重试点 +1 后经 args.retries 传入。
      duration: Math.max(0, Math.round((Date.now() - PROCESS_STARTED_AT) / 1000)),
      error: report.ok ? null : report.failures.join('; ').slice(0, 200) || null,
      project: path.basename(path.resolve(opts.projectRoot)),
      cwd: path.resolve(opts.projectRoot),
    }, deps.db ? { db: deps.db } : {});
    return { skipped: false, recorded: Boolean(recorded), phase };
  } catch {
    return { skipped: true, reason: 'delivery-record-failed' };
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.error) {
    console.error(`[hdl-evidence-gate] ${opts.error}`);
    process.exit(2);
  }

  const report = { gate: 'hdl-evidence-gate', version: 1, projectRoot: path.resolve(opts.projectRoot).replace(/\\/g, '/'), ok: true, failures: [] };
  if (opts.checklist) {
    try { report.checklist = checklistInventory(opts.checklist); }
    catch (err) { report.failures.push(err.message); }
  }

  if (opts.arch) {
    const { ok, result } = checkArch(opts.projectRoot);
    report.arch = result;
    if (!ok) {
      report.ok = false;
      report.failures.push(`arch: ${result.reason}`);
    }
  }

  if (opts.golden) {
    report.golden = checkGolden(opts.projectRoot);
    report.failures.push(...report.golden.failures);
  }
  if (opts.rtlReady || opts.fixedPoint) {
    report.mode = opts.lite ? 'lite' : 'full';
    report.withBaseline = opts.withBaseline === true;
    let models;
    if (!opts.lite) {
      try {
        const checked = checkFixedPoint(opts.projectRoot, opts.modules, opts.withBaseline, opts.hardLimits);
        models = checked.models;
        report.fixedPointReceiptSha256 = checked.receiptSha256;
        if (opts.withBaseline) report.fixedBaseline = checked.baseline;
        report.hardLimits = opts.hardLimits || {};
        report.fixedPoint = opts.modules;
      } catch (err) { report.failures.push('P2: ' + err.message); }
    }
    if (opts.rtlReady) {
      report.failures.push(...rtlPrerequisites(opts.projectRoot, opts.modules).map(file => 'missing or empty: ' + file));
      for (const mod of opts.modules) {
        try {
          const checkedInterface = checkVerification(opts.projectRoot, mod, models?.get(mod));
          if (checkedInterface) report.interfaceContractSha256 = checkedInterface;
        }
        catch (err) { report.failures.push('P3 ' + mod + ': ' + err.message); }
      }
      if (!report.failures.length) report.rtlReady = opts.modules;
    }
  } else if (opts.modules.length > 0) {
    report.modules = opts.modules.map(mod => checkModule(opts.projectRoot, mod));
    for (const m of report.modules) {
      if (!m.pass) {
        report.ok = false;
        report.failures.push(`${m.module}: ${m.reason}`);
      }
    }
  }

  if (opts.vivadoSummary) {
    report.vivado = checkVivadoSummary(opts.projectRoot, opts.vivadoSummary, {
      minWns: opts.minWns,
      minWhs: opts.minWhs,
      maxLatches: opts.maxLatches,
      maxCdcCritical: opts.maxCdcCritical,
    });
    if (!report.vivado.pass) {
      report.failures.push(...report.vivado.failures.map((f) => `vivado: ${f}`));
    }
  }

  report.ok = report.failures.length === 0;
  if (!opts.golden && !opts.rtlReady && !opts.fixedPoint && !opts.checklist && !opts.vivadoSummary) recordPhaseDelivery(report, opts);

  console.log(JSON.stringify(report, null, 2));
  console.log(report.ok ? 'RESULT: PASS' : 'RESULT: FAIL');
  process.exit(report.ok ? 0 : 1);
}

if (require.main === module) main();

module.exports = { checkArch, checkModule, checkVivadoSummary, parseArgs, recordPhaseDelivery, checklistInventory };
