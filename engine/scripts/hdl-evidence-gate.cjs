#!/usr/bin/env node
'use strict';

/**
 * engine/scripts/hdl-evidence-gate.cjs — HDL 工作流确定性证据门禁。
 *
 * 背景: hdl-coding-dag-workflow 的 Phase 1b/4/4.5 需要读磁盘证据
 * (architecture.yaml / 02_sim/check_results/*.json)。Workflow 运行时没有
 * 文件系统 API —— 旧版工作流指望一个从未存在的 globalThis.workflowFs 桥,
 * 导致证据门禁在生产路径上从未运行过。本脚本把证据判定移出工作流:
 * 工作流派一个证据 agent 执行本脚本, 判定由这里的确定性代码完成,
 * agent 只负责把输出 JSON 原样带回。
 *
 * 用法:
 *   node engine/scripts/hdl-evidence-gate.cjs --project-root <dir> --arch
 *   node engine/scripts/hdl-evidence-gate.cjs --project-root <dir> --modules a,b,c
 *   node engine/scripts/hdl-evidence-gate.cjs --project-root <dir> --arch --modules a,b,c
 *
 * 输出契约 (供工作流 schema 校验):
 *   stdout 第一段: 单个 JSON 对象 {gate, version, ok, arch?, modules?, failures}
 *   stdout 末行:   RESULT: PASS 或 RESULT: FAIL   (对齐 verification-gate 正面证据判据)
 *   退出码:        0=PASS, 1=FAIL, 2=用法错误
 *
 * 判定规则与旧 Phase 4.5 内联逻辑一致, 未新增规则:
 *   - arch: 06_doc/architecture.yaml 存在, 且含 modules/pipeline_stages/
 *     fsm_states/bit_width/latency 字段 (缺字段 = warning, 不 FAIL —— 与旧行为一致)
 *   - modules: 02_sim/check_results/<mod>.json 每个都存在、可解析、
 *     status === 'PASS' 且 compared_points > 0
 */

const fs = require('node:fs');
const path = require('node:path');

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
    else if (a === '--modules') out.modules = String(argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--json') { /* 输出本就是 JSON, 兼容旗标 */ }
    else return { error: `unknown argument: ${a}` };
  }
  if (!out.arch && out.modules.length === 0) {
    return { error: 'nothing to check: pass --arch and/or --modules a,b,c' };
  }
  return out;
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
 * DAG 阶段级交付落库 (D1, 2026-07-30)。
 *
 * 为什么在这里而不在工作流里: workflow 脚本跑在没有 Node API 的沙箱, 不能直接
 * 调 delivery-tracker —— 这正是 P1 留下的缺口。本脚本是工作流**真实调用**的
 * 确定性证据门禁, 它同时知道阶段 (--arch / --modules) 与判定, 是唯一自然的
 * 落库点。fail-open: 落库失败绝不影响门禁判定 (判定是本脚本的主职责)。
 */
function recordPhaseDelivery(report, opts, deps = {}) {
  if (process.env.CLAUDE_HARNESS_NO_PERSIST === '1'
    || process.env.CLAUDE_HARNESS_VERIFY_READONLY === '1'
    || process.env.CLAUDE_NO_DIAGNOSTIC_WRITES === '1') return { skipped: true };
  try {
    const { recordDelivery } = deps.deliveryTracker || require('./delivery-tracker.cjs');
    const phase = opts.arch && opts.modules.length > 0 ? 'P1b+P4.5'
      : opts.arch ? 'P1b' : 'P4.5';
    const recorded = recordDelivery({
      workflow: 'hdl-coding-dag-workflow',
      phase,
      status: report.ok ? 'pass' : 'fail',
      modules: opts.modules.length,
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

  if (opts.arch) {
    const { ok, result } = checkArch(opts.projectRoot);
    report.arch = result;
    if (!ok) {
      report.ok = false;
      report.failures.push(`arch: ${result.reason}`);
    }
  }

  if (opts.modules.length > 0) {
    report.modules = opts.modules.map(mod => checkModule(opts.projectRoot, mod));
    for (const m of report.modules) {
      if (!m.pass) {
        report.ok = false;
        report.failures.push(`${m.module}: ${m.reason}`);
      }
    }
  }

  recordPhaseDelivery(report, opts);

  console.log(JSON.stringify(report, null, 2));
  console.log(report.ok ? 'RESULT: PASS' : 'RESULT: FAIL');
  process.exit(report.ok ? 0 : 1);
}

if (require.main === module) main();

module.exports = { checkArch, checkModule, parseArgs, recordPhaseDelivery };
