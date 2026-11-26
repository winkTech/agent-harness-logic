#!/usr/bin/env node
'use strict';

/**
 * scripts/release-pin.cjs — 一键六渲染器重建、零漂移核验与发版目录 SHA 钉选编排器
 *
 * 将晋升规则 hrc-17b80b214f7f4adb 的发版/切分支复位流程收敛为单命令：
 *   1. sync-skills.cjs
 *   2. sync-workflow-mirror.cjs
 *   3. render-hook-settings.cjs
 *   4. render-codex-hooks.cjs
 *   5. render-grok-hooks.cjs
 *   6. sync-plugin-dist.cjs (--local 或 --release --commit=<sha>)
 *
 * 默认绝不自动执行 git commit / git push（遵循授权边界）。
 *
 * 用法：
 *   npm run release:pin -- --check [--json]
 *   npm run release:pin -- --build [--local] [--json]
 *   npm run release:pin -- --commit <40-hex-sha> [--owner <name>] [--repo-url <https-url>]
 *   npm run release:pin -- --dry-run
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseArgs } = require('node:util');

const ROOT = path.resolve(__dirname, '..');
const SCRIPTS_DIR = path.join(ROOT, 'core', 'engine', 'scripts');

function buildPipeline(opts = {}) {
  const check = Boolean(opts.check);
  const steps = [
    { name: 'sync-skills', script: 'sync-skills.cjs', args: check ? ['--check'] : [] },
    { name: 'sync-workflow-mirror', script: 'sync-workflow-mirror.cjs', args: check ? ['--check'] : [] },
    { name: 'render-hook-settings', script: 'render-hook-settings.cjs', args: check ? ['--check'] : [] },
    { name: 'render-codex-hooks', script: 'render-codex-hooks.cjs', args: check ? ['--check'] : [] },
    { name: 'render-grok-hooks', script: 'render-grok-hooks.cjs', args: check ? ['--check'] : [] },
  ];

  const distArgs = [];
  if (check) distArgs.push('--check');
  if (opts.commit) {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
    const owner = opts.owner || manifest?.author?.name || 'Agent Harness Logic';
    const repoUrl = opts.repoUrl || manifest?.repository || 'https://github.com/winkTech/agent-harness-logic.git';
    distArgs.push('--release', `--owner=${owner}`, `--repo-url=${repoUrl}`, `--commit=${opts.commit}`);
  } else if (!check && opts.local !== false) {
    distArgs.push('--local');
  }
  steps.push({ name: 'sync-plugin-dist', script: 'sync-plugin-dist.cjs', args: distArgs });

  if (!check) {
    for (const s of ['sync-skills.cjs', 'sync-workflow-mirror.cjs', 'render-hook-settings.cjs', 'render-codex-hooks.cjs', 'render-grok-hooks.cjs', 'sync-plugin-dist.cjs']) {
      steps.push({ name: `verify:${path.basename(s, '.cjs')}`, script: s, args: ['--check'] });
    }
  }
  return steps;
}

function runPipeline(opts = {}) {
  const steps = buildPipeline(opts);
  if (opts.dryRun) {
    return {
      ok: true,
      dryRun: true,
      steps: steps.map((s) => ({ name: s.name, command: `node core/engine/scripts/${s.script} ${s.args.join(' ')}`.trim() })),
    };
  }
  const results = [];
  for (const step of steps) {
    const scriptPath = path.join(SCRIPTS_DIR, step.script);
    const res = spawnSync(process.execPath, [scriptPath, ...step.args], {
      cwd: ROOT,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120_000,
    });
    const ok = !res.error && res.status === 0;
    results.push({
      name: step.name,
      ok,
      exitCode: res.status,
      stdout: String(res.stdout || '').trim(),
      stderr: String(res.stderr || res.error?.message || '').trim(),
    });
    if (!ok) return { ok: false, failedAt: step.name, results };
  }
  return { ok: true, dryRun: false, results };
}

function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      check: { type: 'boolean', default: false },
      build: { type: 'boolean', default: false },
      local: { type: 'boolean', default: true },
      'dry-run': { type: 'boolean', default: false },
      commit: { type: 'string' },
      owner: { type: 'string' },
      'repo-url': { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help || (!values.check && !values.build && !values.commit && !values['dry-run'])) {
    console.log('Usage: node scripts/release-pin.cjs --check | --build | --commit <40-hex-sha> [--owner X] [--repo-url URL] [--dry-run] [--json]');
    return 0;
  }

  const report = runPipeline({
    check: values.check,
    local: values.commit ? false : values.local,
    dryRun: values['dry-run'],
    commit: values.commit,
    owner: values.owner,
    repoUrl: values['repo-url'],
  });

  if (values.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.dryRun) {
    for (const s of report.steps) console.log(`[dry-run] ${s.command}`);
  } else if (report.ok) {
    console.log(`[release:pin] OK (${report.results.length} steps passed, zero drift)`);
  } else {
    const failed = report.results[report.results.length - 1];
    console.error(`[release:pin] FAILED at ${report.failedAt}: ${failed.stderr || failed.stdout}`);
  }
  return report.ok ? 0 : 1;
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (err) {
    console.error(`[release:pin] ${err.message}`);
    process.exitCode = 1;
  }
}

module.exports = { buildPipeline, runPipeline, main };
