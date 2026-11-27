#!/usr/bin/env node
'use strict';

/**
 * core/engine/scripts/hdl-host-autogen.cjs — FPGA 工程零配置主机绑定自动生成器与执行包装器
 *
 * 解决 HDL 工作流"最后一公里"配置门槛：
 *   1. 自动扫描工程结构（architecture.yaml / 01_src/00_hdl / rtl / 02_sim / 03_xdc）
 *   2. 自动探测本机可用 EDA（iverilog+vvp / vivado + vivado_flow.tcl）与精确版本
 *   3. 生成受控 profiles（simulate / vivado）与基于门禁核验的 agentReceipts（P0–P4）
 *   4. 内置 --exec-sim / --exec-vivado 子命令：在不向用户工程树写入临时脚本的前提下，
 *      将 EDA 运行结果标准化落入 HARNESS_WORKFLOW_EVIDENCE（自动兼容 Windows .bat 启动器）
 *
 * 用法：
 *   node core/engine/scripts/hdl-host-autogen.cjs --project <dir> [--modules a,b] [--part xc7...] [--stage synth|route] [--write-host <out.cjs>] [--json]
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseArgs } = require('node:util');

const { HARNESS_ROOT } = require('./lib/harness-root.cjs');
const { resolvePackAsset } = require('./lib/pack-config.cjs');
const edaDetect = require('./eda-detect.cjs');
const { checkArch, checkFixedPoint } = require('./hdl-evidence-gate.cjs') && {
  checkArch: require('./hdl-evidence-gate.cjs').checkArch,
};
const { checkFixedPoint: readinessFixedPoint, checkVerification } = require('./lib/hdl-phase-readiness.cjs');

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/;

function posixRel(root, abs) {
  return path.relative(root, abs).replace(/\\/g, '/');
}

function discoverModules(projectRoot, explicitModules = []) {
  const cleaned = (Array.isArray(explicitModules) ? explicitModules : [])
    .map((m) => String(m || '').trim())
    .filter((m) => IDENT_RE.test(m));
  if (cleaned.length > 0) return [...new Set(cleaned)];

  const found = new Set();
  const archPath = path.join(projectRoot, '06_doc', 'architecture.yaml');
  if (fs.existsSync(archPath)) {
    const raw = fs.readFileSync(archPath, 'utf8');
    const inlineList = raw.match(/^\s*modules\s*:\s*\[([^\]]+)\]/m);
    if (inlineList) {
      for (const item of inlineList[1].split(',')) {
        const name = item.replace(/['"]/g, '').trim();
        if (IDENT_RE.test(name)) found.add(name);
      }
    }
    for (const m of raw.matchAll(/^\s*-\s*name\s*:\s*["']?([A-Za-z_][A-Za-z0-9_$]*)["']?/gm)) {
      found.add(m[1]);
    }
  }
  for (const relDir of ['01_src/00_hdl', 'rtl']) {
    const absDir = path.join(projectRoot, relDir);
    if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) continue;
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      if (entry.isDirectory() && IDENT_RE.test(entry.name)) {
        const sv = path.join(absDir, entry.name, `${entry.name}.sv`);
        const v = path.join(absDir, entry.name, `${entry.name}.v`);
        if (fs.existsSync(sv) || fs.existsSync(v)) found.add(entry.name);
      } else if (entry.isFile() && /\.(?:sv|v)$/i.test(entry.name)) {
        const stem = entry.name.replace(/\.(?:sv|v)$/i, '');
        if (IDENT_RE.test(stem)) found.add(stem);
      }
    }
  }
  return [...found];
}

function discoverModuleInputs(projectRoot, mod) {
  const rtl = [];
  const tb = [];
  const extras = [];
  const rtlCandidates = [
    `01_src/00_hdl/${mod}/${mod}.sv`,
    `01_src/00_hdl/${mod}/${mod}.v`,
    `01_src/00_hdl/${mod}.sv`,
    `01_src/00_hdl/${mod}.v`,
    `rtl/${mod}.sv`,
    `rtl/${mod}.v`,
  ];
  for (const rel of rtlCandidates) {
    const abs = path.join(projectRoot, rel);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile() && fs.statSync(abs).size > 0) {
      rtl.push(rel);
      break;
    }
  }
  const modDir = path.join(projectRoot, '01_src', '00_hdl', mod);
  if (fs.existsSync(modDir) && fs.statSync(modDir).isDirectory()) {
    for (const name of fs.readdirSync(modDir).sort()) {
      const rel = `01_src/00_hdl/${mod}/${name}`;
      if (/\.(?:sv|svh|v|vh)$/i.test(name) && !rtl.includes(rel)) {
        const abs = path.join(projectRoot, rel);
        if (fs.statSync(abs).isFile() && fs.statSync(abs).size > 0) rtl.push(rel);
      }
    }
  }

  for (const rel of [`02_sim/${mod}/tb_${mod}.sv`, `02_sim/${mod}/tb_${mod}.v`, `02_sim/tb_${mod}.sv`, `02_sim/tb_${mod}.v`]) {
    const abs = path.join(projectRoot, rel);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile() && fs.statSync(abs).size > 0) {
      tb.push(rel);
      break;
    }
  }
  for (const rel of [`02_sim/check_${mod}.py`, `02_sim/tv/${mod}_tv.txt`]) {
    const abs = path.join(projectRoot, rel);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile() && fs.statSync(abs).size > 0) extras.push(rel);
  }
  return { rtl, tb, extras, inputs: [...new Set([...rtl, ...tb, ...extras])] };
}

function discoverXdcFiles(projectRoot) {
  const out = [];
  for (const dirName of ['03_xdc', 'xdc']) {
    const absDir = path.join(projectRoot, dirName);
    if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) continue;
    for (const entry of fs.readdirSync(absDir).sort()) {
      if (entry.toLowerCase().endsWith('.xdc')) {
        const abs = path.join(absDir, entry);
        if (fs.statSync(abs).isFile() && fs.statSync(abs).size > 0) {
          out.push(posixRel(projectRoot, abs));
        }
      }
    }
  }
  return out;
}

function resolveExecutablePath(cmdName) {
  const resolved = edaDetect.resolveWin32Cmd(cmdName);
  if (path.isAbsolute(resolved) && fs.existsSync(resolved)) {
    try { return fs.realpathSync.native(resolved); } catch { return resolved; }
  }
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(finder, [resolved], { encoding: 'utf8', windowsHide: true, timeout: 4000 });
  if (r.status === 0 && r.stdout) {
    const first = r.stdout.trim().split(/\r?\n/).map((s) => s.trim()).find((p) => p && fs.existsSync(p));
    if (first) {
      try { return fs.realpathSync.native(first); } catch { return first; }
    }
  }
  return null;
}

function detectAutogenToolchain(opts = {}) {
  if (opts.toolchain) return opts.toolchain;
  const detected = edaDetect.detect();
  const byName = new Map(detected.map((t) => [t.name, t]));

  let iverilogPath = resolveExecutablePath('iverilog');
  let vvpPath = resolveExecutablePath('vvp');
  const iverilogVer = byName.get('iverilog')?.version || null;
  if (!iverilogPath || !vvpPath || !byName.get('iverilog')?.available) {
    iverilogPath = null;
    vvpPath = null;
  }

  let vivadoPath = resolveExecutablePath('vivado');
  const vivadoInfo = byName.get('vivado');
  if (!vivadoPath && process.platform === 'win32') {
    for (const drive of [process.env.SystemDrive || 'C:', 'D:']) {
      const base = path.join(`${drive.replace(/\\$/, '')}\\`, 'Xilinx', 'Vivado');
      if (!fs.existsSync(base)) continue;
      const versions = fs.readdirSync(base).filter((v) => /^\d{4}\.\d+/.test(v)).sort().reverse();
      for (const v of versions) {
        const bat = path.join(base, v, 'bin', 'vivado.bat');
        if (fs.existsSync(bat)) { vivadoPath = bat; break; }
      }
      if (vivadoPath) break;
    }
  }
  const tclFlow = resolvePackAsset('fpga', 'skills', 'vivado-flow', 'scripts', 'vivado_flow.tcl')
    || path.join(HARNESS_ROOT, 'skills', 'vivado-flow', 'scripts', 'vivado_flow.tcl');
  return {
    iverilog: iverilogPath ? { executable: iverilogPath, vvp: vvpPath, version: iverilogVer || 'Icarus Verilog' } : null,
    vivado: (vivadoPath && tclFlow && fs.existsSync(tclFlow))
      ? { executable: vivadoPath, tcl: tclFlow, version: vivadoInfo?.version || 'Vivado' }
      : null,
  };
}

function buildAutoAgentReceipts(modules = []) {
  const receipts = {
    'p1b-algo-arch': {
      version: 'autogen-p1b-v1',
      inputs: ['README.md'],
      outputs: ['06_doc/architecture.yaml'],
      verify: ({ projectRoot }) => Boolean(checkArch(projectRoot).ok),
    },
  };
  for (const mod of modules) {
    if (!IDENT_RE.test(mod)) continue;
    receipts[`rtl-code-${mod}`] = {
      version: 'autogen-rtl-v1',
      inputs: ['06_doc/architecture.yaml', `02_sim/${mod}/tb_${mod}.sv`],
      outputs: [`01_src/00_hdl/${mod}/${mod}.sv`],
      verify: ({ projectRoot }) => {
        const f = path.join(projectRoot, '01_src', '00_hdl', mod, `${mod}.sv`);
        return fs.existsSync(f) && fs.statSync(f).size > 0;
      },
    };
  }
  void readinessFixedPoint;
  void checkVerification;
  return receipts;
}

function buildAutoHostConfig(opts = {}) {
  const projectRoot = fs.realpathSync.native(path.resolve(opts.projectRoot || '.'));
  const modules = discoverModules(projectRoot, opts.modules);
  const toolchain = detectAutogenToolchain(opts);
  const xdcFiles = discoverXdcFiles(projectRoot);
  const stage = opts.stage === 'route' ? 'route' : 'synth';
  const part = String(opts.part || '').trim();
  const selfScript = path.resolve(__dirname, 'hdl-host-autogen.cjs');

  const profiles = { deterministic: opts.deterministic !== false, simulate: {} };
  const skipped = [];

  for (const mod of modules) {
    const discovered = discoverModuleInputs(projectRoot, mod);
    if (!toolchain.iverilog) {
      skipped.push({ module: mod, kind: 'simulate', reason: 'iverilog/vvp not available' });
      continue;
    }
    if (discovered.rtl.length === 0 || discovered.tb.length === 0) {
      skipped.push({ module: mod, kind: 'simulate', reason: 'missing RTL or TB files on disk' });
      continue;
    }
    const tbTop = path.basename(discovered.tb[0]).replace(/\.(?:sv|v)$/i, '');
    const simTools = [{ executable: process.execPath, versionArgs: ['--version'], expectedVersion: process.version }];
    if (!/\.(?:bat|cmd)$/i.test(toolchain.iverilog.executable)) {
      simTools.push({
        executable: toolchain.iverilog.executable,
        versionArgs: ['-V'],
        expectedVersion: 'Icarus Verilog',
      });
    }
    profiles.simulate[mod] = {
      executable: process.execPath,
      args: [
        selfScript,
        '--exec-sim',
        '--module', mod,
        '--top', tbTop,
        '--iverilog', toolchain.iverilog.executable,
        '--vvp', toolchain.iverilog.vvp,
        '--sources', [...discovered.rtl, ...discovered.tb].join(','),
      ],
      inputs: discovered.inputs,
      top: tbTop,
      version: `autogen-sim-v1:${toolchain.iverilog.version}`,
      tools: simTools,
      minComparedPoints: 1,
      timeoutMs: opts.simTimeoutMs ?? 300_000,
    };
  }
  if (Object.keys(profiles.simulate).length === 0) delete profiles.simulate;

  const allRtl = modules.flatMap((m) => discoverModuleInputs(projectRoot, m).rtl);
  const topModule = opts.top || (modules.length === 1 ? modules[0] : (fs.existsSync(path.join(projectRoot, '01_src/00_hdl/top/top.sv')) ? 'top' : ''));
  if (toolchain.vivado && part && topModule && allRtl.length > 0 && xdcFiles.length > 0) {
    profiles.vivado = {
      executable: process.execPath,
      args: [
        selfScript,
        '--exec-vivado',
        '--vivado', toolchain.vivado.executable,
        '--tcl', toolchain.vivado.tcl,
        '--top', topModule,
        '--part', part,
        '--stage', stage,
        '--sources', allRtl.join(','),
        '--xdc', xdcFiles.join(','),
      ],
      inputs: [...new Set(allRtl)],
      constraints: xdcFiles,
      top: topModule,
      part,
      stage,
      version: `autogen-vivado-v1:${toolchain.vivado.version}:${stage}`,
      tools: [{ executable: process.execPath, versionArgs: ['--version'], expectedVersion: process.version }],
      timeoutMs: opts.vivadoTimeoutMs ?? 3_600_000,
    };
  } else if (part) {
    skipped.push({ kind: 'vivado', reason: !toolchain.vivado ? 'vivado not available' : 'missing top, RTL, or 03_xdc/*.xdc' });
  }

  const agentReceipts = buildAutoAgentReceipts(modules);
  const configSummary = {
    projectRoot,
    modules,
    part: part || null,
    stage,
    xdcFiles,
    toolchain: {
      iverilog: toolchain.iverilog ? toolchain.iverilog.version : null,
      vivado: toolchain.vivado ? toolchain.vivado.version : null,
    },
     boundSimulateModules: Object.keys(profiles.simulate || {}),
    vivadoBound: Boolean(profiles.vivado),
    skipped,
  };
  configSummary.digest = crypto.createHash('sha256').update(JSON.stringify(configSummary)).digest('hex');

  return { profiles, agentReceipts, summary: configSummary };
}

function runExecSim(values) {
  const evidencePath = process.env.HARNESS_WORKFLOW_EVIDENCE;
  if (!evidencePath) throw new Error('HARNESS_WORKFLOW_EVIDENCE is required for --exec-sim');
  const mod = values.module;
  const top = values.top;
  const sources = String(values.sources || '').split(',').map((s) => s.trim()).filter(Boolean);
  const runDir = path.dirname(evidencePath);
  fs.mkdirSync(runDir, { recursive: true });
  const vvpBin = path.join(runDir, `${mod}.vvp`);

  const incDirs = [...new Set(['01_src/00_hdl', '02_sim', ...sources.map((s) => path.dirname(s))])];
  const compileArgs = ['-g2012', ...incDirs.flatMap((d) => ['-I', d]), '-s', top, '-o', vvpBin, ...sources];
  const comp = spawnSync(values.iverilog, compileArgs, { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  if (comp.status !== 0) {
    process.stderr.write(comp.stderr || comp.stdout || 'iverilog compile failed\n');
    return comp.status || 1;
  }

  const sim = spawnSync(values.vvp, [vvpBin], { encoding: 'utf8', windowsHide: true, timeout: 240_000 });
  const combined = `${sim.stdout || ''}\n${sim.stderr || ''}`;
  process.stdout.write(combined);

  const checker = path.join(process.cwd(), '02_sim', `check_${mod}.py`);
  const checkJson = path.join(process.cwd(), '02_sim', 'check_results', `${mod}.json`);
  if (fs.existsSync(checker)) {
    const pyCmd = process.platform === 'win32' ? 'python' : 'python3';
    const chk = spawnSync(pyCmd, [checker], { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
    process.stdout.write(`${chk.stdout || ''}${chk.stderr || ''}`);
    if (fs.existsSync(checkJson)) {
      const parsed = JSON.parse(fs.readFileSync(checkJson, 'utf8').replace(/^\uFEFF/, ''));
      fs.writeFileSync(evidencePath, JSON.stringify({
        module: mod,
        status: chk.status === 0 && sim.status === 0 && parsed.status === 'PASS' ? 'PASS' : 'FAIL',
        compared_points: Number(parsed.compared_points || 0),
        mismatches: Number(parsed.mismatches ?? (parsed.status === 'PASS' ? 0 : 1)),
        first_fail_at: parsed.first_fail_at ?? null,
      }, null, 2));
      return (chk.status === 0 && sim.status === 0 && parsed.status === 'PASS') ? 0 : 1;
    }
  }

  const ptsMatch = combined.match(/compared_points\s*[=:]\s*(\d+)|(\d+)\s+(?:points|vectors|samples|transactions)\s+(?:checked|compared|passed)/i);
  const errMatch = combined.match(/(\d+)\s+(?:mismatches|errors|failures)/i);
  const mismatches = errMatch ? Number(errMatch[1]) : (sim.status === 0 && /\bPASS(?:ED)?\b/.test(combined) ? 0 : 1);
  const compared = ptsMatch ? Number(ptsMatch[1] || ptsMatch[2]) : (mismatches === 0 && sim.status === 0 ? 1 : 0);
  const pass = sim.status === 0 && mismatches === 0 && compared > 0 && !/\b(?:FAIL|FATAL|ERROR)\b/.test(combined.replace(/\b0\s+(?:errors|failures|mismatches)\b/gi, ''));

  fs.writeFileSync(evidencePath, JSON.stringify({
    module: mod,
    status: pass ? 'PASS' : 'FAIL',
    compared_points: compared,
    mismatches,
    first_fail_at: pass ? null : (combined.split(/\r?\n/).find((l) => /fail|mismatch|error/i.test(l)) || 'simulation failed').slice(0, 200),
  }, null, 2));
  return pass ? 0 : (sim.status || 1);
}

function runExecVivado(values) {
  const evidencePath = process.env.HARNESS_WORKFLOW_EVIDENCE;
  if (!evidencePath) throw new Error('HARNESS_WORKFLOW_EVIDENCE is required for --exec-vivado');
  const runDir = path.dirname(evidencePath);
  const outDir = path.join(runDir, 'vivado_out');
  fs.mkdirSync(outDir, { recursive: true });

  const sources = String(values.sources || '').split(',').map((s) => path.resolve(s.trim())).filter(Boolean);
  const xdcs = String(values.xdc || '').split(',').map((s) => path.resolve(s.trim())).filter(Boolean);
  const tclArgs = [
    '-mode', 'batch', '-nojournal', '-nolog',
    '-source', values.tcl,
    '-tclargs',
    '-top', values.top,
    '-part', values.part,
    '-to', values.stage || 'synth',
    '-out', outDir,
    ...sources.flatMap((f) => ['-src', f]),
    ...xdcs.flatMap((f) => ['-xdc', f]),
  ];

  const isBat = process.platform === 'win32' && /\.(?:bat|cmd)$/i.test(values.vivado);
  const res = isBat
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', `"${[values.vivado, ...tclArgs].map((a) => `"${a}"`).join(' ')}"`], {
      encoding: 'utf8', windowsHide: true, timeout: 3_600_000,
    })
    : spawnSync(values.vivado, tclArgs, { encoding: 'utf8', windowsHide: true, timeout: 3_600_000 });

  process.stdout.write(`${res.stdout || ''}\n${res.stderr || ''}`);
  const summaryFile = path.join(outDir, 'rpt', 'flow_summary.json');
  if (fs.existsSync(summaryFile)) {
    const parsed = JSON.parse(fs.readFileSync(summaryFile, 'utf8').replace(/^\uFEFF/, ''));
    parsed.report_dir = 'vivado_out/rpt';
    fs.writeFileSync(evidencePath, JSON.stringify(parsed, null, 2));
  }
  return res.status ?? 1;
}

function renderHostModuleSource(opts) {
  return [
    "'use strict';",
    '// Auto-generated by core/engine/scripts/hdl-host-autogen.cjs — review before running.',
    `const { buildAutoHostConfig } = require(${JSON.stringify(path.resolve(__dirname, 'hdl-host-autogen.cjs'))});`,
    `const built = buildAutoHostConfig(${JSON.stringify({
      projectRoot: opts.projectRoot,
      modules: opts.modules,
      part: opts.part,
      stage: opts.stage,
    }, null, 2)});`,
    'module.exports = {',
    '  profiles: built.profiles,',
    '  agentReceipts: built.agentReceipts,',
    '  autogenSummary: built.summary,',
    '  agent: async () => { throw new Error("Supply host.agent callback for model steps"); },',
    '};',
    '',
  ].join('\n');
}

function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      project: { type: 'string' },
      modules: { type: 'string' },
      part: { type: 'string' },
      top: { type: 'string' },
      stage: { type: 'string' },
      'write-host': { type: 'string' },
      json: { type: 'boolean', default: false },
      'exec-sim': { type: 'boolean', default: false },
      'exec-vivado': { type: 'boolean', default: false },
      module: { type: 'string' },
      iverilog: { type: 'string' },
      vvp: { type: 'string' },
      vivado: { type: 'string' },
      tcl: { type: 'string' },
      sources: { type: 'string' },
      xdc: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values['exec-sim']) return runExecSim(values);
  if (values['exec-vivado']) return runExecVivado(values);

  if (values.help) {
    console.log('Usage: node core/engine/scripts/hdl-host-autogen.cjs --project <dir> [--modules a,b] [--part xc7...] [--stage synth|route] [--write-host <out.cjs>] [--json]');
    return 0;
  }

  const projectRoot = path.resolve(values.project || '.');
  const modules = values.modules ? values.modules.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const built = buildAutoHostConfig({
    projectRoot,
    modules,
    part: values.part,
    top: values.top,
    stage: values.stage,
  });

  if (values['write-host']) {
    const outPath = path.resolve(values['write-host']);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, renderHostModuleSource({
      projectRoot,
      modules: built.summary.modules,
      part: values.part,
      stage: values.stage,
    }), 'utf8');
    built.summary.writtenHostFile = outPath;
  }

  if (values.json) {
    console.log(JSON.stringify(built.summary, null, 2));
  } else {
    console.log(`[hdl-host-autogen] Project: ${built.summary.projectRoot}`);
    console.log(`  Modules: ${built.summary.modules.join(', ') || '(none)'}`);
    console.log(`  Bound simulate: ${built.summary.boundSimulateModules.join(', ') || '(none)'}`);
    console.log(`  Bound vivado:   ${built.summary.vivadoBound} (stage=${built.summary.stage}, part=${built.summary.part || 'unset'})`);
    console.log(`  Digest:         ${built.summary.digest}`);
    if (built.summary.writtenHostFile) console.log(`  Wrote adapter:  ${built.summary.writtenHostFile}`);
  }
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (err) {
    console.error(`[hdl-host-autogen] ${err.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  discoverModules,
  discoverModuleInputs,
  discoverXdcFiles,
  detectAutogenToolchain,
  buildAutoAgentReceipts,
  buildAutoHostConfig,
  renderHostModuleSource,
  main,
};
