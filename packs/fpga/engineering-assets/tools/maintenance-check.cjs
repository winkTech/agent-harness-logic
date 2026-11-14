#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { checkCatalog, scanRepository } = require('./catalog-gen.cjs');
const { auditRepository } = require('./asset-audit.cjs');
const { validate: validateRegistry } = require('./integration-registry.cjs');
const { validate: validateWaiver, load: loadWaiver } = require('./waiver-ledger.cjs');
const { verifySnapshot } = require('./evidence-snapshot.cjs');
const { check: checkLineage } = require('./lineage-check.cjs');
const { validateLedger } = require('./extract-cbb.cjs');

function snapshotRefs(root) {
  const refs = [];
  const evidence = path.join(root, 'evidence');
  if (!fs.existsSync(evidence)) return refs;
  for (const uid of fs.readdirSync(evidence)) {
    const uidDir = path.join(evidence, uid);
    if (!fs.statSync(uidDir).isDirectory()) continue;
    for (const version of fs.readdirSync(uidDir)) if (fs.existsSync(path.join(uidDir, version, 'SNAPSHOT.json'))) refs.push([uid, version]);
  }
  return refs;
}

function pipelineLedgers(root) {
  const dir = path.join(root, 'var', 'cbb', 'pipeline');
  const refs = [];
  if (!fs.existsSync(dir)) return refs;
  for (const uid of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, uid, 'stage-ledger.json');
    if (!fs.existsSync(file)) continue;
    try { refs.push({ uid, file, ledger: JSON.parse(fs.readFileSync(file, 'utf8')) }); }
    catch (error) { refs.push({ uid, file, ledger: null, error: error.message }); }
  }
  return refs;
}

function build(root, options = {}) {
  const scan = scanRepository(root);
  const audit = auditRepository(root);
  const levels = {};
  let pass = 0; let nonpass = 0;
  for (const asset of scan.assets) {
    levels[asset.level] = (levels[asset.level] || 0) + 1;
    for (const gate of asset.gate_results?.gates || []) {
      if (gate.status === 'pass' || gate.status === 'na' || gate.status === 'waived') pass += 1;
      else if (gate.status === 'fail' || gate.status === 'blocked') nonpass += 1;
    }
  }
  const refs = snapshotRefs(root); let verified = 0; let historical = 0; const snapshotErrors = [];
  for (const [uid, version] of refs) { try { const result = verifySnapshot(root, uid, version); verified += 1; if (result.historical) historical += 1; } catch (error) { snapshotErrors.push(`${uid}@${version}: ${error.message}`); } }
  let openWaivers = 0;
  try { openWaivers = loadWaiver(root).value.entries.filter((entry) => entry.status === 'open').length; } catch {}
  const deletionPath = path.join(root, 'catalog', 'deletion-manifest.json');
  let deletionCandidates = 0;
  if (fs.existsSync(deletionPath)) deletionCandidates = JSON.parse(fs.readFileSync(deletionPath, 'utf8')).deletion_summary?.permanent_delete_candidates || 0;
  const pipelines = pipelineLedgers(root); const pipelineErrors = []; let pipelineBlocked = 0; let pipelineQualification = 0; let pipelineCertified = 0;
  for (const item of pipelines) {
    if (options.allowInflight) continue;
    if (item.error) { pipelineErrors.push(`${item.uid}: ${item.error}`); continue; }
    pipelineErrors.push(...validateLedger(item.ledger).map((error) => `${item.uid}: ${error}`));
    if (item.ledger.decision?.level === 'blocked') pipelineBlocked += 1;
    if (item.ledger.decision?.level === 'qualification') pipelineQualification += 1;
    if (item.ledger.decision?.certified) {
      pipelineCertified += 1;
      if (item.ledger.external?.blockers?.length) pipelineErrors.push(`${item.uid}: certified decision has external blockers`);
    }
    if (item.ledger.decision?.level === 'qualification' && item.ledger.stages?.some((stage) => stage.required && !['pass', 'na'].includes(stage.status))) pipelineErrors.push(`${item.uid}: qualification decision bypasses unresolved required stage`);
  }
  const report = {
    schema_version: '1.0',
    generated_by: 'maintenance-check.cjs',
    checks: {
      catalog_fresh: checkCatalog(scan, { checkReadme: true }).fresh,
      registry_errors: validateRegistry(root),
      waiver_errors: validateWaiver(root),
      lineage_errors: checkLineage(root),
      snapshot_errors: snapshotErrors,
      audit_red: audit.red.length,
      pipeline_errors: pipelineErrors,
    },
    metrics: {
      asset_count_by_level: Object.fromEntries(Object.entries(levels).sort(([a], [b]) => a.localeCompare(b))),
      gate_pass_ratio: pass + nonpass ? Number((pass / (pass + nonpass)).toFixed(4)) : 1,
      snapshot_freshness: refs.length ? Number((verified / refs.length).toFixed(4)) : 1,
      historical_snapshot_count: historical,
      open_waiver_count: openWaivers,
      documentation_gap_count: audit.yellow.filter((finding) => finding.code === 'A4').length,
      deletion_candidate_count: deletionCandidates,
      pipeline_ledger_count: pipelines.length,
      pipeline_blocked_count: pipelineBlocked,
      pipeline_qualification_count: pipelineQualification,
      pipeline_certified_count: pipelineCertified,
    },
  };
  return report;
}

function main(argv = process.argv.slice(2)) {
  const index = argv.indexOf('--root'); const root = path.resolve(index >= 0 ? argv[index + 1] : path.resolve(__dirname, '..')); const output = path.join(root, 'var', 'audit', 'maintenance-report.json');
  try {
    const report = build(root, { allowInflight: argv.includes('--allow-inflight') });
    if (argv.includes('--write')) { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8'); }
    if (argv.includes('--check')) {
      if (!fs.existsSync(output) || fs.readFileSync(output, 'utf8').replace(/\r\n/g, '\n') !== `${JSON.stringify(report, null, 2)}\n`) { console.error('[maintenance-check] stale or missing maintenance-report.json'); return 1; }
    }
    const errors = [
      ...report.checks.registry_errors,
      ...report.checks.waiver_errors,
      ...report.checks.lineage_errors,
      ...report.checks.snapshot_errors,
      ...report.checks.pipeline_errors,
    ];
    if (!report.checks.catalog_fresh || report.checks.audit_red || errors.length || report.metrics.deletion_candidate_count > 0) { console.error(`[maintenance-check] RED checks=${errors.length} audit_red=${report.checks.audit_red}`); return 1; }
    console.log(`[maintenance-check] GREEN metrics=${JSON.stringify(report.metrics)}`); return 0;
  } catch (error) { console.error(`[maintenance-check] ${error.message}`); return 2; }
}
if (require.main === module) process.exitCode = main();
module.exports = { build, main, snapshotRefs };
