#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  REQUIRED_STAGES,
  createLedger,
  decideQualification,
  assessCandidate,
  discoverInstallRoot,
  discoverVivadoLauncher,
  classifyEdaFailure,
  classifyVivadoRunFailure,
  buildVivadoBatchCommand,
  planCleanup,
  validateLedger,
} = require('./extract-cbb.cjs');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cbb-extract-red-'));
try {
  const namedInstallRoot = path.join(scratch, 'named-install');
  fs.mkdirSync(path.join(namedInstallRoot, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(namedInstallRoot, '.hidden'), { recursive: true });
  fs.writeFileSync(path.join(namedInstallRoot, 'bin', 'official-launcher.exe'), 'fixture');
  fs.writeFileSync(path.join(namedInstallRoot, '.hidden', 'license-source'), 'fixture');
  const discovery = discoverInstallRoot(namedInstallRoot);
  assert.equal(discovery.status, 'pass');
  assert.equal(discovery.recursive, true);
  assert.equal(discovery.hidden_included, true);
  assert.equal(discovery.extension_filter, false);
  assert(discovery.files.some((item) => item.path.includes('.hidden/license-source')));
  assert(discovery.files.every((item) => item.type && (item.type === 'directory' || Number.isInteger(item.bytes))));
  assert(discovery.files.every((item) => !Object.hasOwn(item, 'content') && !Object.hasOwn(item, 'value')));

  assert.equal(
    classifyEdaFailure({ actualPathTested: false, launcher: 'missing' }).category,
    'path-not-tested',
    'a missing command must not blame the environment before the named installation root is tested',
  );
  assert.equal(classifyEdaFailure({ actualPathTested: true, launcher: 'failed' }).category, 'launcher-failure');
  assert.equal(classifyEdaFailure({ actualPathTested: true, launcher: 'pass', config: 'missing' }).category, 'config-discovery-failure');
  assert.equal(
    classifyEdaFailure({ actualPathTested: true, launcher: 'failed', config: 'failed' }).category,
    'config-discovery-failure',
    'an incomplete named-root scan must be resolved before interpreting a missing PATH launcher',
  );
  assert.equal(classifyEdaFailure({ actualPathTested: true, launcher: 'pass', config: 'pass', license: 'failed' }).category, 'license-checkout-failure');
  assert.equal(classifyEdaFailure({ actualPathTested: true, launcher: 'pass', config: 'pass', license: 'pass', execution: 'failed' }).category, 'tool-execution-failure');
  assert.equal(classifyVivadoRunFailure(1, 'ERROR: A valid license was not found for feature Synthesis').category, 'license-checkout-failure');
  assert.equal(classifyVivadoRunFailure(1, 'ERROR: Command failed while reading RTL').category, 'tool-execution-failure');
  const limitedDiscovery = discoverInstallRoot(namedInstallRoot, { maxFiles: 1 });
  assert.equal(limitedDiscovery.status, 'config-discovery-failure');
  assert.equal(limitedDiscovery.path_tested, true, 'a bounded scan still proves that the named path was tested');

  const vivadoFixture = path.join(scratch, 'vivado-2023.1');
  const vivadoFiles = [
    'settings64.bat',
    'bin/setupEnv.bat',
    'bin/vivado.bat',
    'bin/loader.bat',
    'bin/rdiArgs.bat',
    'bin/setEnvAndRunCmd.bat',
    'bin/xlicdiag.bat',
    'bin/unwrapped/win64.o/vivado.exe',
    'bin/unwrapped/win64.o/prodversion.exe',
  ];
  for (const relative of vivadoFiles) {
    const absolute = path.join(vivadoFixture, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, 'fixture');
  }
  const vivadoContract = discoverVivadoLauncher(vivadoFixture);
  assert.equal(vivadoContract.status, 'pass');
  assert.equal(vivadoContract.extension_filter, false);
  assert.deepEqual(vivadoContract.launcher_chain, ['settings64.bat', 'bin/vivado.bat', 'bin/loader.bat']);
  assert.deepEqual(vivadoContract.required_scripts, ['settings64.bat', 'bin/setupEnv.bat', 'bin/loader.bat', 'bin/vivado.bat', 'bin/setEnvAndRunCmd.bat', 'bin/xlicdiag.bat', 'bin/rdiArgs.bat']);
  assert.deepEqual(vivadoContract.per_process_environment, ['APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'PROCESSOR_ARCHITECTURE', 'XILINXD_LICENSE_FILE']);
  assert(vivadoContract.files.some((item) => item.path === 'bin/unwrapped/win64.o/vivado.exe'));
  assert(vivadoContract.official_files.some((item) => item.path === 'bin/vivado.bat' && item.type === 'file'));
  const vivadoCommand = buildVivadoBatchCommand(vivadoFixture, ['-mode', 'batch', '-source', 'probe.tcl']);
  assert.equal(vivadoCommand.command, 'cmd.exe');
  assert.match(vivadoCommand.args.join(' '), /settings64\.bat/);
  assert.match(vivadoCommand.args.join(' '), /bin[\\/]vivado\.bat/);
  assert.match(vivadoCommand.args.join(' '), /-mode batch/);
  assert(vivadoContract.files.every((item) => !Object.hasOwn(item, 'content') && !Object.hasOwn(item, 'value')));

  const ledger = createLedger('fixture_candidate', 'incubator/intake/fixture_candidate', {
    sourcePaths: ['rtl/fixture.sv'],
    finalEvidencePaths: ['evidence/fixture_candidate/0.1.0/SNAPSHOT.json'],
  });
  assert.deepEqual(ledger.stages.map((stage) => stage.id), REQUIRED_STAGES);
  assert.throws(() => decideQualification(ledger), /required stage/i, 'pending stages must block qualification');

  const missingProvenance = structuredClone(ledger);
  missingProvenance.stages.find((stage) => stage.id === 'source_scan_intake').status = 'pass';
  missingProvenance.stages.find((stage) => stage.id === 'classification').status = 'pass';
  missingProvenance.stages.find((stage) => stage.id === 'provenance_license').status = 'fail';
  assert(validateLedger(missingProvenance).some((error) => /provenance_license/.test(error)));

  const complete = structuredClone(ledger);
  for (const stage of complete.stages) {
    stage.status = 'pass';
    stage.evidence = [`var/evidence/${stage.id}.json`];
  }
  complete.provenance = { source: 'fixture://source', license: 'MIT', retrieved: '2026-07-26', basis: 'fixture test' };
  complete.decision = decideQualification(complete);
  assert.equal(complete.decision.level, 'qualification');
  assert.equal(complete.decision.certified, false);

  assert.throws(
    () => planCleanup(complete, ['incubator/intake/fixture_candidate/rtl/fixture.sv']),
    /protected source/i,
    'source RTL must never be removable',
  );
  assert.throws(
    () => planCleanup(complete, ['evidence/fixture_candidate/0.1.0/SNAPSHOT.json']),
    /final evidence/i,
    'final snapshot must never be removable',
  );
  const cleanup = planCleanup(complete, ['var/tmp/fixture_candidate/run.vvp']);
  assert.deepEqual(cleanup.removable, ['var/tmp/fixture_candidate/run.vvp']);

  const repoRoot = path.resolve(__dirname, '..', '..');
  for (const uid of ['stream_elastic_pipeline', 'pulse_merge']) {
    const eda = path.join(repoRoot, 'engineering-assets', 'incubator', 'qualification', uid, 'eda');
    if (!fs.existsSync(eda)) continue;
    const doText = fs.readFileSync(path.join(eda, 'modelsim_sva.do'), 'utf8');
    const tclText = fs.readFileSync(path.join(eda, 'vivado_cert.tcl'), 'utf8');
    assert.match(doText, /set script_dir/);
    assert.match(doText, /CBB_EDA_SCRIPT_DIR/, 'ModelSim recipe must allow a per-process script root override');
    assert.match(doText, /cbb_eda_path/, 'ModelSim recipe must avoid path normalization that drops hidden worktree segments');
    assert.match(doText, /file join \$script_dir/);
    assert.doesNotMatch(doText, /cd \$script_dir/);
    assert.match(tclText, /CBB_EDA_SCRIPT_DIR/, 'Vivado recipe must allow a per-process script root override');
    assert.match(tclText, /cbb_eda_path/, 'Vivado recipe must preserve hidden worktree segments');
    assert.doesNotMatch(tclText, /read_verilog .*file normalize .*file join/);
    assert.doesNotMatch(tclText, /read_xdc .*file normalize .*file join/);
    assert.match(tclText, /read_xdc .*constraints\//);
    assert.doesNotMatch(tclText, /read_xdc .*vivado_cert\.tcl/);
  }
  const rawTemplate = path.join(repoRoot, 'skills', 'hdl-coding', 'templates', 'comm', 'axis_pipeline_reg.sv');
  if (fs.existsSync(rawTemplate)) {
    const assessment = assessCandidate(repoRoot, 'skills/hdl-coding/templates/comm/axis_pipeline_reg.sv');
    assert.equal(assessment.classification.category, 'normalize-and-qualify');
    assert(assessment.blockers.some((error) => /manifest/i.test(error)));
    assert(assessment.blockers.some((error) => /provenance|license/i.test(error)));
    assert(assessment.blockers.some((error) => /requirements/i.test(error)));
    assert.equal(assessment.decision, 'blocked');
  }
  const sop = fs.readFileSync(path.join(repoRoot, 'engineering-assets', 'docs', 'governance', 'new-asset-intake-SOP.md'), 'utf8');
  for (const contract of ['--install-root', '--vivado-root', 'path-not-tested', 'launcher-failure', 'config-discovery-failure', 'license-checkout-failure', 'tool-execution-failure', 'per-process', 'PROCESSOR_ARCHITECTURE', 'settings64.bat', 'bin/vivado.bat', 'bin/loader.bat', 'XILINXD_LICENSE_FILE', 'version -short', 'file normalize', '.codex']) {
    assert.match(sop, new RegExp(contract.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `SOP must retain ${contract} discovery contract`);
  }

  console.log('ok - extraction pipeline contracts');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
