#!/usr/bin/env node
'use strict';

/**
 * core/engine/scripts/blind-audit-seal.cjs — 双盲独立审计预期锁定与四象限探针核验脚本
 *
 * 供 blind-audit-workflow 调用：
 *   1. seal   — 在读取实现者测试前锁定审计员预期矩阵的 SHA-256、时间戳与 Git HEAD
 *   2. verify — 复核预期文件自锁定后未被事后篡改，并核验四象限探针（坏输入拒收 /
 *               过期证据拒收 / 中断恢复 / 好输入零误伤）结果完整性
 *
 * 用法：
 *   node core/engine/scripts/blind-audit-seal.cjs seal --expectation <file> --seal-out <seal.json> [--project <dir>]
 *   node core/engine/scripts/blind-audit-seal.cjs verify --seal <seal.json> [--probes <probes.json>]
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseArgs } = require('node:util');

const REQUIRED_QUADRANTS = Object.freeze([
  'bad_input_rejected',
  'stale_artifact_rejected',
  'interrupted_job_recovered',
  'valid_input_accepted',
]);

function sha256Bytes(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function gitHead(cwd) {
  try {
    const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', windowsHide: true, timeout: 5000 });
    return r.status === 0 ? r.stdout.trim() : null;
  } catch {
    return null;
  }
}

function sealExpectations(opts = {}) {
  const expPath = path.resolve(opts.expectationPath);
  if (!fs.existsSync(expPath) || !fs.statSync(expPath).isFile()) {
    throw new Error(`Expectation file missing: ${expPath}`);
  }
  const bytes = fs.readFileSync(expPath);
  if (bytes.length < 32) {
    throw new Error('Expectation file is too short to contain concrete testable predictions');
  }
  const projectRoot = opts.projectRoot ? path.resolve(opts.projectRoot) : process.cwd();
  const seal = {
    schemaVersion: 1,
    kind: 'blind-audit-seal',
    sealedAt: new Date().toISOString(),
    projectRoot,
    gitHead: gitHead(projectRoot),
    expectationPath: expPath,
    expectationBytes: bytes.length,
    expectationSha256: sha256Bytes(bytes),
  };
  seal.sealSha256 = sha256Bytes(Buffer.from(JSON.stringify(seal), 'utf8'));

  if (opts.sealOutPath) {
    const out = path.resolve(opts.sealOutPath);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(seal, null, 2)}\n`, 'utf8');
  }
  return seal;
}

function verifyAuditSeal(opts = {}) {
  const sealPath = path.resolve(opts.sealPath);
  const failures = [];
  if (!fs.existsSync(sealPath)) {
    return { ok: false, failures: [`seal file not found: ${sealPath}`] };
  }
  let seal;
  try {
    seal = JSON.parse(fs.readFileSync(sealPath, 'utf8'));
  } catch (err) {
    return { ok: false, failures: [`unparseable seal JSON: ${err.message}`] };
  }
  const { sealSha256, ...rest } = seal || {};
  if (!sealSha256 || sha256Bytes(Buffer.from(JSON.stringify(rest), 'utf8')) !== sealSha256) {
    failures.push('seal integrity digest mismatch');
  }
  if (!seal?.expectationPath || !fs.existsSync(seal.expectationPath)) {
    failures.push(`sealed expectation file missing: ${seal?.expectationPath || '(unset)'}`);
  } else {
    const actualSha = sha256Bytes(fs.readFileSync(seal.expectationPath));
    if (actualSha !== seal.expectationSha256) {
      failures.push('expectation file was modified after blind seal (post-hoc tampering detected)');
    }
  }

  let quadrantReport = null;
  if (opts.probesPath) {
    const probesFile = path.resolve(opts.probesPath);
    if (!fs.existsSync(probesFile)) {
      failures.push(`probes file not found: ${probesFile}`);
    } else {
      try {
        const probes = JSON.parse(fs.readFileSync(probesFile, 'utf8'));
        quadrantReport = {};
        for (const q of REQUIRED_QUADRANTS) {
          const item = probes?.quadrants?.[q];
          if (!item || typeof item.executed !== 'boolean' || typeof item.pass !== 'boolean') {
            failures.push(`missing or incomplete quadrant probe: ${q}`);
          } else {
            quadrantReport[q] = item;
          }
        }
      } catch (err) {
        failures.push(`invalid probes JSON: ${err.message}`);
      }
    }
  }

  return {
    ok: failures.length === 0,
    sealedAt: seal?.sealedAt || null,
    expectationSha256: seal?.expectationSha256 || null,
    quadrants: quadrantReport,
    failures,
  };
}

function main(argv = process.argv.slice(2)) {
  const cmd = argv[0];
  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      expectation: { type: 'string' },
      'seal-out': { type: 'string' },
      seal: { type: 'string' },
      probes: { type: 'string' },
      project: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help || !['seal', 'verify'].includes(cmd)) {
    console.log('Usage: blind-audit-seal.cjs seal --expectation <file> --seal-out <seal.json> [--project <dir>]');
    console.log('       blind-audit-seal.cjs verify --seal <seal.json> [--probes <probes.json>]');
    return cmd ? 2 : 0;
  }

  if (cmd === 'seal') {
    const seal = sealExpectations({
      expectationPath: values.expectation,
      sealOutPath: values['seal-out'],
      projectRoot: values.project,
    });
    console.log(JSON.stringify(seal, null, 2));
    console.log('RESULT: PASS');
    return 0;
  }

  const verified = verifyAuditSeal({ sealPath: values.seal, probesPath: values.probes });
  console.log(JSON.stringify(verified, null, 2));
  console.log(verified.ok ? 'RESULT: PASS' : 'RESULT: FAIL');
  return verified.ok ? 0 : 1;
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (err) {
    console.error(`[blind-audit-seal] ${err.message}`);
    console.log('RESULT: FAIL');
    process.exitCode = 1;
  }
}

module.exports = {
  REQUIRED_QUADRANTS,
  sealExpectations,
  verifyAuditSeal,
  main,
};
