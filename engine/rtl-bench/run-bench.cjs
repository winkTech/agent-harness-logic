#!/usr/bin/env node
'use strict';

// RTL Bench runner — 单次评测: 装配工作区 → 驱动 agent → 判卷 → 出 run.json
//
// 用法:
//   node engine/rtl-bench/run-bench.cjs --task <taskDir> --track A|B|C \
//     --agent claude|codex --harness bare|full --out <dir> [--allow-network]
//   node engine/rtl-bench/run-bench.cjs --task <taskDir> --track A|B|C \
//     --dry-run --solution <file> --out <dir>
//
// dry-run: 不跑 agent,把 --solution 当作 agent 交付物放进工作区后直接判卷,
//          用于验证 runner+grader 链路(A/C 默认取 ref,B 必须显式给 --solution)。
// live:    需要 --allow-network,且凭证走 CLAUDE_LIVE_EVAL_ANTHROPIC_API_KEY /
//          CLAUDE_LIVE_EVAL_OAUTH_TOKEN / CODEX_LIVE_EVAL_OPENAI_API_KEY(与
//          rtl-live-task-eval.cjs 同约定),agent 在隔离沙箱 HOME 中运行。
//
// harness 维度(pilot 定义):
//   bare — 工作区只有任务书与 workspace 文件
//   full — 额外注入 hdl-coding SKILL、01-hdl 规则、vivado-flow SKILL+脚本,
//          并放置 AGENTS.md 要求遵循(注: 不含 hook 强制层,live hook 版是后续项)
//
// 退出码: 0 判卷 pass / 1 判卷 fail / 2 用法、环境或运行错误

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadTask, writeJson, argValue, ensureDir, sha256File } = require('./graders/lib/common.cjs');

const HOME = path.resolve(__dirname, '..', '..');
const GRADERS = {
  A: path.join(__dirname, 'graders', 'grade-track-a.cjs'),
  B: path.join(__dirname, 'graders', 'grade-track-b.cjs'),
  C: path.join(__dirname, 'graders', 'grade-track-c.cjs'),
};
const HARNESS_FULL_ASSETS = [
  ['skills/hdl-coding/SKILL.md', 'harness/hdl-coding/SKILL.md'],
  ['docs/rules/01-hdl.md', 'harness/rules/01-hdl.md'],
  ['skills/vivado-flow/SKILL.md', 'harness/vivado-flow/SKILL.md'],
  ['skills/vivado-flow/scripts/vivado_flow.tcl', 'harness/vivado-flow/scripts/vivado_flow.tcl'],
];
const SAFE_ENV_KEYS = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC',
  'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TERM', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
];
const FORBIDDEN_LIVE_PATTERNS = [
  /--dangerously-bypass-approvals-and-sandbox\b/i,
  /--permission-mode\s+bypassPermissions\b/i,
];

function usage() {
  return [
    'Usage:',
    '  node run-bench.cjs --task <taskDir> --track A|B|C --agent claude|codex --harness bare|full --out <dir> --allow-network',
    '  node run-bench.cjs --task <taskDir> --track A|B|C --dry-run [--solution <file>] --out <dir>',
  ].join('\n');
}

function copyInto(src, dest) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

// manifest workspace 条目: "src -> dest"(无箭头则同名)
function assembleWorkspace(taskDir, manifest, track, workspaceDir) {
  ensureDir(workspaceDir);
  const placed = [];
  for (const entry of manifest.tracks[track].workspace || []) {
    const [src, dest] = entry.includes('->') ? entry.split('->').map((s) => s.trim()) : [entry.trim(), entry.trim()];
    copyInto(path.join(taskDir, src), path.join(workspaceDir, dest));
    placed.push(dest);
  }
  const brief = fs.readFileSync(path.join(taskDir, manifest.tracks[track].brief), 'utf8');
  fs.writeFileSync(path.join(workspaceDir, 'TASK.md'), brief, 'utf8');
  placed.push('TASK.md');
  return placed;
}

function injectHarness(workspaceDir) {
  const placed = [];
  for (const [src, dest] of HARNESS_FULL_ASSETS) {
    const srcPath = path.join(HOME, src);
    if (!fs.existsSync(srcPath)) continue;
    copyInto(srcPath, path.join(workspaceDir, dest));
    placed.push(dest);
  }
  fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'), [
    '# 工作规则',
    '',
    '- 动手前先读 `harness/hdl-coding/SKILL.md` 与 `harness/rules/01-hdl.md`,RTL 编码遵循其规范。',
    '- 需要综合/时序/资源证据时,用 `harness/vivado-flow/SKILL.md` 描述的方式跑 `harness/vivado-flow/scripts/vivado_flow.tcl`,结论以 `flow_summary.json` 数字为准;不跑工具不下综合结论。',
    '- 功能验证用 ModelSim(vlog/vsim 在 PATH 上),验证要证明通用行为而不是只迎合固定样例。',
    '- 只在本工作区内读写文件。',
    '',
  ].join('\n'), 'utf8');
  placed.push('AGENTS.md');
  return placed;
}

function buildIsolatedEnv(sandboxHome, sourceEnv = process.env) {
  const resolvedHome = path.resolve(sandboxHome);
  const env = {};
  for (const key of SAFE_ENV_KEYS) {
    if (typeof sourceEnv[key] === 'string' && sourceEnv[key]) env[key] = sourceEnv[key];
  }
  const tempDir = path.join(resolvedHome, 'tmp');
  for (const dir of [resolvedHome, tempDir]) ensureDir(dir);
  Object.assign(env, {
    HOME: resolvedHome,
    USERPROFILE: resolvedHome,
    APPDATA: path.join(resolvedHome, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(resolvedHome, 'AppData', 'Local'),
    TEMP: tempDir,
    TMP: tempDir,
  });
  if (sourceEnv.CLAUDE_LIVE_EVAL_ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = sourceEnv.CLAUDE_LIVE_EVAL_ANTHROPIC_API_KEY;
  if (sourceEnv.CLAUDE_LIVE_EVAL_OAUTH_TOKEN) env.CLAUDE_CODE_OAUTH_TOKEN = sourceEnv.CLAUDE_LIVE_EVAL_OAUTH_TOKEN;
  if (sourceEnv.CODEX_LIVE_EVAL_OPENAI_API_KEY) env.OPENAI_API_KEY = sourceEnv.CODEX_LIVE_EVAL_OPENAI_API_KEY;
  return env;
}

function agentCommand(agent) {
  if (agent === 'claude') {
    return process.env.RTL_BENCH_CLAUDE_COMMAND
      || 'claude -p --verbose --output-format stream-json --permission-mode default --no-session-persistence --allowedTools Read,Write,Edit,Glob,Grep,Bash';
  }
  if (agent === 'codex') {
    return process.env.RTL_BENCH_CODEX_COMMAND
      || (process.platform === 'win32'
        ? 'npx.cmd -y @openai/codex@0.142.5 exec --ignore-user-config --json --sandbox workspace-write --skip-git-repo-check --ephemeral --color never'
        : 'npx -y @openai/codex@0.142.5 exec --ignore-user-config --json --sandbox workspace-write --skip-git-repo-check --ephemeral --color never');
  }
  throw new Error(`unknown agent: ${agent}`);
}

function parseCommandLine(command) {
  const parts = [];
  let current = '';
  let quote = '';
  let started = false;
  for (const ch of String(command || '')) {
    if ((ch === '"' || ch === "'") && (!quote || quote === ch)) { quote = quote ? '' : ch; started = true; continue; }
    if (/\s/.test(ch) && !quote) { if (started) parts.push(current); current = ''; started = false; continue; }
    current += ch; started = true;
  }
  if (started) parts.push(current);
  return parts;
}

// 转写统计: 工具调用数 + claude result 事件的用量/成本
function analyzeTranscript(text, workspaceDir) {
  const stats = { events: 0, toolCalls: 0, outsideWrites: [], costUsd: null, usage: null, resultText: null };
  const wsNorm = path.resolve(workspaceDir).replace(/\\/g, '/').toLowerCase();
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let ev;
    try { ev = JSON.parse(trimmed); } catch { continue; }
    stats.events++;
    const parts = ev?.message && Array.isArray(ev.message.content) ? ev.message.content : [];
    for (const p of parts) {
      if (p.type !== 'tool_use') continue;
      stats.toolCalls++;
      const fp = p.input?.file_path || p.input?.path || '';
      if (fp && path.isAbsolute(fp)) {
        const norm = path.resolve(fp).replace(/\\/g, '/').toLowerCase();
        if (norm !== wsNorm && !norm.startsWith(`${wsNorm}/`)) stats.outsideWrites.push(`${p.name}: ${fp}`);
      }
    }
    if (ev?.type === 'item.started' && ev?.item?.type === 'command_execution') stats.toolCalls++;
    if (ev?.type === 'result') {
      stats.costUsd = ev.total_cost_usd ?? null;
      stats.usage = ev.usage ?? null;
      stats.resultText = typeof ev.result === 'string' ? ev.result.slice(0, 4000) : null;
    }
  }
  return stats;
}

function runGrader(track, taskDir, deliverablePath, gradeDir) {
  const args = [GRADERS[track], '--task', taskDir, '--out', gradeDir];
  if (track === 'B') args.push('--tb', deliverablePath);
  else args.push('--rtl', deliverablePath);
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true, timeout: 30 * 60 * 1000 });
  const gradePath = path.join(gradeDir, 'grade.json');
  return {
    exitCode: r.status,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').slice(-2000),
    grade: fs.existsSync(gradePath) ? JSON.parse(fs.readFileSync(gradePath, 'utf8')) : null,
  };
}

function main() {
  const args = process.argv.slice(2);
  const taskDir = path.resolve(argValue(args, '--task'));
  const track = argValue(args, '--track');
  const agent = argValue(args, '--agent', 'claude');
  const harness = argValue(args, '--harness', 'bare');
  const outDir = path.resolve(argValue(args, '--out'));
  const dryRun = args.includes('--dry-run');
  const allowNetwork = args.includes('--allow-network');
  const timeoutMin = Number(argValue(args, '--timeout-min', '30'));

  if (!taskDir || !outDir || !['A', 'B', 'C'].includes(track)) { console.error(usage()); process.exit(2); }
  if (!['bare', 'full'].includes(harness)) { console.error(usage()); process.exit(2); }
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0) {
    console.error(`output directory is not empty: ${outDir}`);
    process.exit(2);
  }

  const manifest = loadTask(taskDir);
  if (!manifest.tracks[track]) { console.error(`task has no track ${track}`); process.exit(2); }
  const deliverableRel = manifest.tracks[track].deliverable;

  const workspaceDir = path.join(outDir, 'workspace');
  const placed = assembleWorkspace(taskDir, manifest, track, workspaceDir);
  if (harness === 'full') placed.push(...injectHarness(workspaceDir));

  const run = {
    schemaVersion: 1,
    benchmark: 'rtl-bench',
    task: manifest.id,
    difficulty: manifest.difficulty,
    track,
    agent: dryRun ? 'dry-run' : agent,
    harness,
    startedAt: new Date().toISOString(),
    workspaceFiles: placed,
    agentRun: null,
    transcriptStats: null,
    grading: null,
    verdict: 'fail',
  };

  if (dryRun) {
    // 把指定解答(默认 ref)放到交付物路径,验证 runner+grader 链路
    const solution = argValue(args, '--solution')
      || (track === 'B' ? '' : path.join(taskDir, 'ref', `${manifest.top}.sv`));
    if (!solution || !fs.existsSync(solution)) {
      console.error('dry-run requires --solution <file> (track B has no default)');
      process.exit(2);
    }
    copyInto(path.resolve(solution), path.join(workspaceDir, deliverableRel));
    run.dryRunSolution = path.resolve(solution);
  } else {
    if (!allowNetwork) { console.error('live mode requires --allow-network'); process.exit(2); }
    const command = agentCommand(agent);
    const bad = FORBIDDEN_LIVE_PATTERNS.find((p) => p.test(command));
    if (bad) { console.error(`forbidden live command pattern: ${bad.source}`); process.exit(2); }

    const prompt = [
      '你在一个独立的 RTL 工作区中完成一项任务,任务书是工作区根下的 TASK.md。',
      harness === 'full' ? '工作区根下有 AGENTS.md 工作规则,必须遵守。' : '',
      '',
      '硬性要求:',
      `- 交付物路径(相对工作区根): ${deliverableRel}`,
      '- 只在本工作区内读写文件,不要访问或修改工作区外的任何路径。',
      '- ModelSim(vlog/vsim)与 Vivado 在 PATH 上,可用于自测。',
      '- 结束时在最后回复中说明: 交付物路径、跑过哪些验证、剩余风险。',
    ].filter(Boolean).join('\n');

    const env = buildIsolatedEnv(path.join(outDir, 'sandbox-home'));
    const parts = parseCommandLine(command);
    const started = Date.now();
    const r = spawnSync(parts[0], parts.slice(1), {
      cwd: workspaceDir, input: prompt, encoding: 'utf8',
      timeout: timeoutMin * 60 * 1000, windowsHide: false, env,
    });
    const transcript = (r.stdout || '');
    fs.writeFileSync(path.join(outDir, 'transcript.jsonl'), transcript, 'utf8');
    fs.writeFileSync(path.join(outDir, 'agent-stderr.log'), r.stderr || '', 'utf8');
    run.agentRun = {
      command: parts.join(' '),
      exitCode: r.status,
      signal: r.signal,
      error: r.error ? String(r.error.message) : null,
      durationMs: Date.now() - started,
    };
    run.transcriptStats = analyzeTranscript(transcript, workspaceDir);
  }

  // 判卷(交付物缺失时不调 grader,直接 fail)
  const deliverablePath = path.join(workspaceDir, deliverableRel);
  if (!fs.existsSync(deliverablePath)) {
    run.grading = { error: `deliverable missing: ${deliverableRel}` };
  } else {
    run.deliverableSha256 = sha256File(deliverablePath);
    run.grading = runGrader(track, taskDir, deliverablePath, path.join(outDir, 'grade'));
    run.verdict = run.grading.grade && run.grading.grade.verdict === 'pass' ? 'pass' : 'fail';
  }
  run.completedAt = new Date().toISOString();
  writeJson(path.join(outDir, 'run.json'), run);
  console.log(`RUN: ${run.verdict.toUpperCase()} (task=${run.task}, track=${track}, agent=${run.agent}, harness=${harness})`);
  if (run.grading && run.grading.stdout) console.log(run.grading.stdout);
  process.exit(run.verdict === 'pass' ? 0 : 1);
}

main();
