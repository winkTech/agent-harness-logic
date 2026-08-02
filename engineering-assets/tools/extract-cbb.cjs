#!/usr/bin/env node
'use strict';

// Zero-dependency orchestration only. Existing governance tools remain the
// authority for schema, redline, gate, snapshot, catalog, lineage, and audit.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');

// 受保护路径判定 (lib/protected-write.cjs): 本脚本经 Bash 运行, 会写 manifest,
// 因而绕过只拦 Edit/Write 的 file-protection hook。判定与
// manifest-hash-refresh.cjs 共用同一份实现, 不各写一份以免漂移。
const { blockReason } = require('./lib/protected-write.cjs');

const REQUIRED_STAGES = [
  'source_scan_intake',
  'classification',
  'provenance_license',
  'requirements',
  'normalized_rtl',
  'golden_reference',
  'reusable_sva',
  'randomized_verification',
  'lint_gate_snapshot',
  'eda_certification_package',
  'qualification_decision',
  'temporary_cleanup',
  'catalog_audit_update',
];

const STAGE_STATUS = new Set(['pending', 'pass', 'na', 'blocked', 'fail']);
const TEMP_ROOTS = ['var/tmp', 'var/build', 'var/scratch'];
const SOURCE_EXT = /\.(?:sv|v|vh|py|m|tcl|do|xdc|json|md|txt|hex|bin)$/i;
const SKIP_DIRS = new Set(['.git', 'node_modules']);

function slash(value) { return String(value).split(path.sep).join('/').replace(/^\.\//, ''); }

function canonicalBytes(file) {
  const bytes = fs.readFileSync(file);
  return /\.(?:json|rpt|txt|log|tcl|xdc|sv|v|m|do|md)$/i.test(file)
    ? Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')
    : bytes;
}

function sha256(file) { return crypto.createHash('sha256').update(canonicalBytes(file)).digest('hex'); }

function relative(root, target) {
  const absRoot = path.resolve(root);
  const absTarget = path.resolve(target);
  const rel = slash(path.relative(absRoot, absTarget));
  if (!rel || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) throw new Error(`path outside root: ${target}`);
  return rel;
}

function resolveCandidate(root, candidate) {
  const abs = path.resolve(root, candidate || '.');
  const rel = relative(root, abs);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`candidate package missing: ${rel}`);
  return { abs, rel };
}

function walkFiles(root, current = root, out = []) {
  if (!fs.existsSync(current)) return out;
  for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const abs = path.join(current, entry.name);
    if (entry.isDirectory()) walkFiles(root, abs, out);
    else if (entry.isFile()) out.push({ abs, path: relative(root, abs) });
  }
  return out;
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

function writeJson(file, value) {
  const blocked = blockReason(file);
  if (blocked) throw new Error(`[protected-write] ${blocked}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readManifest(packageDir) {
  const file = path.join(packageDir, 'manifest.json');
  if (!fs.existsSync(file)) throw new Error(`manifest missing: ${file}`);
  const manifest = readJson(file);
  if (!manifest.asset_uid || !manifest.maturity || !manifest.maturity.level) throw new Error('manifest asset_uid/maturity.level required');
  return { file, manifest };
}

function stage(id) { return { id, required: true, status: 'pending', evidence: [] }; }

function createLedger(assetUid, candidatePath, options = {}) {
  if (!assetUid || !candidatePath) throw new Error('assetUid and candidatePath are required');
  const sourcePaths = (options.sourcePaths || []).map(slash).sort();
  const finalEvidencePaths = (options.finalEvidencePaths || [`evidence/${assetUid}`]).map(slash).sort();
  return {
    schema_version: '1.0',
    tool: 'extract-cbb.cjs',
    asset_uid: assetUid,
    candidate_path: slash(candidatePath),
    source_paths: sourcePaths,
    final_evidence_paths: finalEvidencePaths,
    stages: REQUIRED_STAGES.map(stage),
    provenance: null,
    cleanup: { allowed_roots: [...TEMP_ROOTS], removable: [], rejected: [] },
    decision: null,
  };
}

function stageById(ledger, id) {
  const item = (ledger.stages || []).find((candidate) => candidate.id === id);
  if (!item) throw new Error(`unknown stage: ${id}`);
  return item;
}

function setStage(ledger, id, status, evidence = [], rationale = null, reviewedBy = null) {
  if (!STAGE_STATUS.has(status)) throw new Error(`invalid stage status: ${status}`);
  const item = stageById(ledger, id);
  item.status = status;
  item.evidence = [...new Set(evidence.map(slash))].sort();
  if (rationale) item.rationale = rationale;
  if (reviewedBy) item.reviewed_by = reviewedBy;
  return ledger;
}

function validateLedger(ledger) {
  const errors = [];
  if (!ledger || typeof ledger !== 'object') return ['ledger must be an object'];
  if (JSON.stringify((ledger.stages || []).map((item) => item.id)) !== JSON.stringify(REQUIRED_STAGES)) errors.push('stage order or required stage set is invalid');
  const seen = new Set();
  for (const item of ledger.stages || []) {
    if (seen.has(item.id)) errors.push(`duplicate stage: ${item.id}`);
    seen.add(item.id);
    if (!STAGE_STATUS.has(item.status)) errors.push(`${item.id}: invalid status`);
    if (item.required && ['pending', 'blocked', 'fail'].includes(item.status)) errors.push(`${item.id}: required stage status=${item.status}`);
    if (item.status === 'na' && (!item.rationale || !item.reviewed_by)) errors.push(`${item.id}: reviewed NA requires rationale and reviewed_by`);
    if (item.required !== true) errors.push(`${item.id}: required must remain true`);
  }
  const prov = ledger.provenance;
  if (stageByIdSafe(ledger, 'provenance_license')?.status === 'pass') {
    for (const key of ['source', 'license', 'retrieved', 'basis']) if (!prov || !prov[key]) errors.push(`provenance_license: ${key} is required`);
  }
  const protectedPaths = [...(ledger.source_paths || []), ...(ledger.final_evidence_paths || [])].map(slash);
  if (new Set(protectedPaths).size !== protectedPaths.length) errors.push('protected source/evidence paths must be unique');
  return errors;
}

function stageByIdSafe(ledger, id) { return (ledger?.stages || []).find((item) => item.id === id) || null; }

function decideQualification(ledger) {
  const errors = validateLedger(ledger);
  const unresolved = (ledger.stages || []).filter((item) => item.status !== 'pass' && item.status !== 'na');
  if (errors.length || unresolved.length) {
    throw new Error(`required stage(s) unresolved: ${[...new Set([...errors, ...unresolved.map((item) => `${item.id}=${item.status}`)])].join('; ')}`);
  }
  const external = ledger.external || {};
  const blockers = [...(external.blockers || [])];
  return {
    level: 'qualification',
    certified: false,
    local_prerequisites: 'pass',
    certification_blockers: blockers,
    rationale: blockers.length ? 'Local reusable contract and evidence stages pass; external certification evidence remains unresolved.' : 'Local qualification pipeline passed; certified promotion still requires signed external closure.',
  };
}

function classifyPath(filePath, manifestLevel = null) {
  const p = slash(filePath);
  if (p.startsWith('cbb/')) return { category: manifestLevel === 'certified' ? 'promote-to-CBB' : 'normalize-and-qualify', deletion_candidate: false, reason: 'certified area is governed source' };
  if (p.startsWith('incubator/')) return { category: 'normalize-and-qualify', deletion_candidate: false, reason: 'incubator source requires qualification' };
  if (p.startsWith('skills/hdl-coding/templates/')) return { category: 'normalize-and-qualify', deletion_candidate: false, reason: 'reusable HDL template requires governed package intake' };
  if (p.startsWith('reference-assets/vendor/') || p.startsWith('knowledge/') || p.startsWith('models/')) return { category: 'retain-as-evidence/source', deletion_candidate: false, reason: 'source or evidence lineage is retained' };
  if (p.startsWith('var/tmp/') || p.startsWith('var/build/') || p.startsWith('var/scratch/')) return { category: 'permanent-delete candidate', deletion_candidate: false, reason: 'generated path is not deletable until all five conditions are independently proven' };
  return { category: SOURCE_EXT.test(p) ? 'retain-as-evidence/source' : 'retain-as-evidence/source', deletion_candidate: false, reason: 'unclassified repository material remains protected by default' };
}

function assessCandidate(root, candidate) {
  const abs = path.resolve(root, candidate);
  const rel = relative(root, abs);
  const blockers = [];
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) blockers.push('candidate source file is missing');
  const sourceDir = fs.existsSync(abs) ? path.dirname(abs) : path.dirname(abs);
  let cursor = sourceDir; let manifestPath = null; let provenancePath = null; let licensePath = null; let requirementsPath = null;
  while (cursor.startsWith(path.resolve(root))) {
    for (const name of ['manifest.json']) if (!manifestPath && fs.existsSync(path.join(cursor, name))) manifestPath = path.join(cursor, name);
    for (const name of ['provenance.json', 'docs/provenance.json']) if (!provenancePath && fs.existsSync(path.join(cursor, name))) provenancePath = path.join(cursor, name);
    for (const name of ['LICENSE', 'LICENSE-MIT.txt', 'COPYING']) if (!licensePath && fs.existsSync(path.join(cursor, name))) licensePath = path.join(cursor, name);
    for (const name of ['docs/requirements.md', 'requirements.md']) if (!requirementsPath && fs.existsSync(path.join(cursor, name))) requirementsPath = path.join(cursor, name);
    const next = path.dirname(cursor); if (next === cursor) break; cursor = next;
  }
  if (!manifestPath) blockers.push('manifest.json is missing; raw source cannot enter qualification');
  if (!provenancePath && !licensePath) blockers.push('provenance/license evidence is missing');
  if (!requirementsPath) blockers.push('requirements document is missing');
  const classification = classifyPath(rel);
  return {
    schema_version: '1.0',
    tool: 'extract-cbb.cjs',
    candidate_path: rel,
    source_exists: fs.existsSync(abs),
    source_sha256: fs.existsSync(abs) ? sha256(abs) : null,
    classification,
    nearby_evidence: {
      manifest: manifestPath ? slash(path.relative(root, manifestPath)) : null,
      provenance: provenancePath ? slash(path.relative(root, provenancePath)) : null,
      license: licensePath ? slash(path.relative(root, licensePath)) : null,
      requirements: requirementsPath ? slash(path.relative(root, requirementsPath)) : null,
    },
    blockers,
    decision: blockers.length ? 'blocked' : 'eligible-for-package-intake',
  };
}

function scanRepository(root) {
  const files = walkFiles(root).map((file) => ({ path: file.path, bytes: fs.statSync(file.abs).size, classification: classifyPath(file.path) }));
  return { schema_version: '1.0', root: slash(path.resolve(root)), file_count: files.length, files };
}

function scanCandidate(root, candidate) {
  const pkg = resolveCandidate(root, candidate);
  const manifestInfo = readManifest(pkg.abs);
  const inventory = scanRepository(root);
  const packageFiles = inventory.files.filter((file) => file.path === pkg.rel || file.path.startsWith(`${pkg.rel}/`));
  const sources = (manifestInfo.manifest.sources || []).map((source) => ({ ...source, path: slash(path.join(pkg.rel, source.path)), exists: fs.existsSync(path.join(pkg.abs, source.path)) }));
  return {
    candidate_path: pkg.rel,
    manifest: manifestInfo.manifest,
    package_files: packageFiles,
    declared_sources: sources,
    inventory,
    classification: classifyPath(pkg.rel, manifestInfo.manifest.maturity.level),
  };
}

function captureProvenance(packageDir, manifest) {
  const records = [];
  let source = manifest.provenance || null;
  const provenanceFile = path.join(packageDir, 'docs', 'provenance.json');
  if (fs.existsSync(provenanceFile)) { const fileValue = readJson(provenanceFile); source = { ...(source || {}), ...fileValue, basis: fileValue.retrieved_basis || fileValue.basis || 'docs/provenance.json' }; records.push('docs/provenance.json'); }
  const licenseFiles = walkFiles(packageDir).filter((file) => /(?:^|[\\/])(?:LICENSE|COPYING)(?:[._-].*)?$/i.test(file.path));
  if (licenseFiles.length) records.push(...licenseFiles.map((file) => slash(path.relative(packageDir, file.abs))));
  if (!source || !source.source || !source.license || !source.retrieved) return { status: 'blocked', evidence: records, error: 'source/license/retrieved provenance is missing' };
  if (!source.basis && !source.retrieved_basis && !source.source_basis) return { status: 'blocked', evidence: records, error: 'provenance basis is missing' };
  return { status: 'pass', evidence: records.sort(), record: { source: source.source, license: source.license, retrieved: source.retrieved, basis: source.basis || source.retrieved_basis || source.source_basis, commit: source.commit ?? null, license_files: records.filter((item) => /LICENSE|COPYING/i.test(item)) } };
}

function requiredPackageFiles(packageDir, manifest) {
  const expected = ['README.md', 'CHANGELOG.md', 'docs/requirements.md', 'docs/limitations.md', 'rtl', 'model', 'sva', 'tb', 'manifest.json'];
  const missing = expected.filter((item) => !fs.existsSync(path.join(packageDir, item)));
  const declared = new Set((manifest.sources || []).map((source) => source.path));
  const missingSources = (manifest.sources || []).filter((source) => !fs.existsSync(path.join(packageDir, source.path))).map((source) => source.path);
  return { missing, missingSources, declaredCount: declared.size };
}

function structuralCdcAudit(packageDir, manifest) {
  const rtl = (manifest.sources || []).filter((source) => source.role === 'rtl').map((source) => path.join(packageDir, source.path));
  const text = rtl.filter(fs.existsSync).map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  const clocks = [...new Set([...text.matchAll(/posedge\s+([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]))];
  const declared = manifest.clock?.name ? [manifest.clock.name] : [];
  const otherClocks = clocks.filter((clock) => !declared.includes(clock));
  const primitives = (text.match(/\b(?:async_fifo|cdc|xpm_cdc|sync_\w+)\b/gi) || []).length;
  if (clocks.length <= 1 && otherClocks.length === 0 && primitives === 0) {
    return { status: 'na', reviewed_by: 'lihan', rationale: `CDC crossing analysis is not applicable: manifest declares one clock (${declared[0] || 'unspecified'}), structural RTL scan found no second clock or CDC primitive. This NA is explicit and reviewable; single-clock structural evidence is still retained.`, clocks, primitives };
  }
  return { status: 'blocked', rationale: 'CDC analysis is required because multiple clocks or CDC primitives were found; external CDC tool evidence is required.', clocks, other_clocks: otherClocks, primitives };
}

function discoverInstallRoot(installRoot, options = {}) {
  const root = path.resolve(String(installRoot));
  const maxFiles = Number.isInteger(options.maxFiles) && options.maxFiles > 0 ? options.maxFiles : 100000;
  const result = {
    root: slash(root),
    path_tested: true,
    recursive: true,
    hidden_included: true,
    extension_filter: false,
    files: [],
  };
  if (!fs.existsSync(root)) return { ...result, status: 'config-discovery-failure', error: 'installation root is missing' };
  let rootStat;
  try { rootStat = fs.lstatSync(root); } catch (error) { return { ...result, status: 'config-discovery-failure', error: `installation root stat failed: ${error.code || error.message}` }; }
  if (!rootStat.isDirectory()) return { ...result, status: 'config-discovery-failure', error: 'installation root is not a directory' };
  const pending = [root];
  try {
    while (pending.length) {
      const current = pending.pop();
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const absolute = path.join(current, entry.name);
        const stat = fs.lstatSync(absolute);
        const type = entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other';
        result.files.push({
          path: slash(path.relative(root, absolute)),
          type,
          extension: path.extname(entry.name),
          bytes: stat.isFile() ? stat.size : null,
        });
        if (result.files.length > maxFiles) return { ...result, status: 'config-discovery-failure', error: `installation scan exceeded maxFiles=${maxFiles}` };
        if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(absolute);
      }
    }
  } catch (error) {
    return { ...result, status: 'config-discovery-failure', error: `installation scan failed: ${error.code || error.message}` };
  }
  return { ...result, status: 'pass', files: result.files.sort((a, b) => a.path.localeCompare(b.path)) };
}

const VIVADO_REQUIRED_SCRIPTS = [
  'settings64.bat',
  'bin/setupEnv.bat',
  'bin/loader.bat',
  'bin/vivado.bat',
  'bin/setEnvAndRunCmd.bat',
  'bin/xlicdiag.bat',
  'bin/rdiArgs.bat',
];

function discoverVivadoLauncher(vivadoRoot, options = {}) {
  const root = path.resolve(String(vivadoRoot));
  const discovery = options.discovery || discoverInstallRoot(root, options);
  const requiredExecutables = ['bin/unwrapped/win64.o/vivado.exe', 'bin/unwrapped/win64.o/prodversion.exe'];
  const officialPaths = [...new Set([...VIVADO_REQUIRED_SCRIPTS, ...requiredExecutables])];
  const officialFiles = officialPaths.map((relative) => {
    const absolute = path.join(root, relative);
    try {
      const stat = fs.lstatSync(absolute);
      return { path: slash(relative), type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other', extension: path.extname(relative), bytes: stat.isFile() ? stat.size : null };
    } catch (error) {
      return { path: slash(relative), type: 'missing', extension: path.extname(relative), bytes: null, error: error.code || error.message };
    }
  });
  const officialFileSet = new Set(officialFiles.filter((item) => item.type === 'file').map((item) => item.path.toLowerCase()));
  const missingScripts = VIVADO_REQUIRED_SCRIPTS.filter((relative) => !officialFileSet.has(relative.toLowerCase()));
  const missingExecutables = requiredExecutables.filter((relative) => !officialFileSet.has(relative.toLowerCase()));
  const status = discovery.status === 'pass' && missingScripts.length === 0 && missingExecutables.length === 0 ? 'pass' : 'config-discovery-failure';
  return {
    root: slash(root),
    status,
    path_tested: discovery.path_tested === true,
    recursive: discovery.recursive === true,
    hidden_included: discovery.hidden_included === true,
    extension_filter: false,
    files: discovery.files || [],
    official_files: officialFiles,
    required_scripts: VIVADO_REQUIRED_SCRIPTS,
    missing_scripts: missingScripts,
    required_executables: requiredExecutables,
    missing_executables: missingExecutables,
    launcher_chain: ['settings64.bat', 'bin/vivado.bat', 'bin/loader.bat'],
    version_probe: {
      launcher: 'settings64.bat -> bin/vivado.bat',
      args: ['-version'],
      expected: 'exit 0 with official version output',
    },
    tcl_probe: {
      launcher: 'settings64.bat -> bin/vivado.bat',
      args: ['-mode', 'batch', '-nolog', '-nojournal', '-notrace', '-source', '<probe.tcl>'],
      command: 'version -short',
      expected: 'exit 0 with CBB_VIVADO_VERSION_SHORT output',
    },
    per_process_environment: ['APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'PROCESSOR_ARCHITECTURE', 'XILINXD_LICENSE_FILE'],
    official_launcher_required: true,
    config_error: discovery.error || (missingScripts.length || missingExecutables.length ? 'official launcher chain is incomplete' : null),
  };
}

function normalizeProbeStatus(value) {
  if (value && typeof value === 'object') return normalizeProbeStatus(value.status);
  if (value === 'available' || value === 'pass') return 'pass';
  if (value === 'missing' || value === 'failed') return 'failed';
  return value || 'not-run';
}

function classifyEdaFailure(facts = {}) {
  if (facts.actualPathTested !== true) return { category: 'path-not-tested', blocked: true, reason: 'named installation root was not recursively scanned before tool status was assessed' };
  if (normalizeProbeStatus(facts.config) === 'failed') return { category: 'config-discovery-failure', blocked: true, reason: 'launcher/configuration source was not discoverable or valid' };
  if (normalizeProbeStatus(facts.launcher) === 'failed') return { category: 'launcher-failure', blocked: true, reason: 'official launcher did not start successfully' };
  if (normalizeProbeStatus(facts.license) === 'failed') return { category: 'license-checkout-failure', blocked: true, reason: 'tool reached license checkout and was rejected' };
  if (normalizeProbeStatus(facts.execution) === 'failed') return { category: 'tool-execution-failure', blocked: true, reason: 'tool execution failed after launcher/config/license checks' };
  if ([facts.launcher, facts.config, facts.license, facts.execution].every((value) => ['pass', 'available'].includes(value))) return { category: 'pass', blocked: false, reason: null };
  return { category: 'pending', blocked: true, reason: 'launcher/config/license/execution evidence is incomplete' };
}

function classifyVivadoRunFailure(exitCode, output = '') {
  if (exitCode === 0) return { category: 'pass', blocked: false, reason: null };
  const text = String(output || '');
  if (/license|checkout|valid license was not found|license environment/i.test(text)) {
    return { category: 'license-checkout-failure', blocked: true, reason: 'Vivado started but rejected the requested synthesis/device license' };
  }
  if (!text.trim()) return { category: 'launcher-failure', blocked: true, reason: 'official Vivado launcher returned nonzero without tool output' };
  return { category: 'tool-execution-failure', blocked: true, reason: 'Vivado launched but the requested batch operation failed' };
}

function toolProbe(command, args, cwd) {
  const result = cp.spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 30000, windowsHide: true });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  return { command, args, status: result.error?.code === 'ENOENT' ? 'missing' : result.status === 0 ? 'available' : 'failed', exit_code: result.status, error: result.error?.message || null, output: output.slice(0, 4000) };
}

function quoteCmdArg(value) {
  const text = String(value);
  return /^[A-Za-z0-9_./\\:=+-]+$/.test(text) ? text : `"${text.replace(/"/g, '""')}"`;
}

function buildVivadoBatchCommand(vivadoRoot, args) {
  const root = path.resolve(String(vivadoRoot));
  const settings = path.join(root, 'settings64.bat');
  const launcher = path.join(root, 'bin', 'vivado.bat');
  const commandLine = `call ${quoteCmdArg(settings)} && call ${quoteCmdArg(launcher)} ${args.map(quoteCmdArg).join(' ')}`;
  return { command: 'cmd.exe', args: ['/d', '/s', '/c', commandLine], launcher_chain: ['settings64.bat', 'bin/vivado.bat', 'bin/loader.bat'] };
}

function officialVivadoRun(vivadoRoot, args, cwd, options = {}) {
  const bootstrapRoot = path.resolve(options.bootstrapRoot || path.join(cwd, 'vivado-appdata'));
  const tempRoot = path.join(bootstrapRoot, 'temp');
  fs.mkdirSync(path.join(bootstrapRoot, 'Xilinx', 'Vivado'), { recursive: true });
  fs.mkdirSync(tempRoot, { recursive: true });
  const invocation = buildVivadoBatchCommand(vivadoRoot, args);
  const processArchitecture = process.env.PROCESSOR_ARCHITECTURE || (process.arch === 'x64' ? 'AMD64' : process.arch === 'ia32' ? 'x86' : 'AMD64');
  const env = { ...process.env, APPDATA: bootstrapRoot, LOCALAPPDATA: bootstrapRoot, TEMP: tempRoot, TMP: tempRoot, PROCESSOR_ARCHITECTURE: processArchitecture };
  const result = cp.spawnSync(invocation.command, invocation.args, { cwd, env, encoding: 'utf8', timeout: options.timeout || 600000, windowsHide: true });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  return { ...invocation, status: result.error?.code === 'ENOENT' ? 'missing' : result.status === 0 ? 'available' : 'failed', exit_code: result.status, error: result.error?.message || null, output: output.slice(0, 6000), bootstrap_root: slash(bootstrapRoot) };
}

function probeEdaTools(cwd, options = {}) {
  const installationRoots = (options.installRoots || []).map((installRoot) => discoverInstallRoot(installRoot, { maxFiles: options.maxFiles }));
  const actualPathTested = installationRoots.length > 0 && installationRoots.every((item) => item.path_tested === true);
  const vivadoRoot = options.vivadoRoot || (installationRoots.find((item) => /(?:^|\/)vivado(?:\/|$)/i.test(item.root)) || {}).root;
  const vivadoDiscovery = vivadoRoot
    ? discoverVivadoLauncher(vivadoRoot, { maxFiles: options.maxFiles, discovery: installationRoots.find((item) => item.root === slash(path.resolve(vivadoRoot))) })
    : null;
  const compactVivadoDiscovery = vivadoDiscovery && {
    ...vivadoDiscovery,
    file_count: Array.isArray(vivadoDiscovery.files) ? vivadoDiscovery.files.length : 0,
    files_truncated: Array.isArray(vivadoDiscovery.files) && vivadoDiscovery.files.length > 200,
    files: Array.isArray(vivadoDiscovery.files) ? vivadoDiscovery.files.slice(0, 200) : [],
  };
  const probes = {
    modelsim_vlog: toolProbe('vlog', ['-version'], cwd),
    modelsim_vsim: toolProbe('vsim', ['-version'], cwd),
    vivado: toolProbe('vivado', ['-version'], cwd),
    vivado_launcher: compactVivadoDiscovery,
  };
  const commandFailed = Object.values(probes).some((item) => item.status !== 'available');
  const compactInstallationRoots = installationRoots.map((item) => ({
    ...item,
    file_count: Array.isArray(item.files) ? item.files.length : 0,
    files_truncated: Array.isArray(item.files) && item.files.length > 200,
    files: Array.isArray(item.files) ? item.files.slice(0, 200) : [],
  }));
  return {
    ...probes,
    installation_roots: compactInstallationRoots,
    policy: {
      actual_path_tested: actualPathTested,
      official_launcher_required: true,
      per_process_environment_only: true,
      failure: classifyEdaFailure({
        actualPathTested,
        launcher: commandFailed ? 'failed' : 'pass',
        config: !vivadoDiscovery || vivadoDiscovery.missing_scripts.length > 0 || vivadoDiscovery.missing_executables.length > 0 ? 'failed' : 'pass',
      }),
    },
  };
}

function quoteTcl(value) { return String(value).replace(/[{}]/g, ''); }

function prepareEdaPackage(root, candidate, options = {}) {
  const pkg = resolveCandidate(root, candidate);
  const { manifest } = readManifest(pkg.abs);
  const edaDir = path.join(pkg.abs, 'eda');
  fs.mkdirSync(edaDir, { recursive: true });
  const tbSource = (manifest.sources || []).find((source) => source.role === 'tb');
  const rtlSources = (manifest.sources || []).filter((source) => source.role === 'rtl').map((source) => `../${slash(source.path)}`);
  const constraintSources = (manifest.sources || []).filter((source) => source.role === 'constraint' && source.path !== 'eda/vivado_cert.tcl').map((source) => `../${slash(source.path)}`);
  const svaSources = (manifest.sources || []).filter((source) => /(?:^|[\\/])sva[\\/].*\.(?:sv|v)$/i.test(source.path)).map((source) => `../${slash(source.path)}`);
  const tbModule = tbSource && fs.existsSync(path.join(pkg.abs, tbSource.path))
    ? (fs.readFileSync(path.join(pkg.abs, tbSource.path), 'utf8').match(/\bmodule\s+([A-Za-z_][A-Za-z0-9_]*)/) || [])[1]
    : null;
  const modelSimDo = [
    '# Generated by extract-cbb.cjs; fail-closed certification recipe.',
    'set script_dir [file dirname [file normalize [info script]]]',
    'if {[info exists ::env(CBB_EDA_SCRIPT_DIR)] && $::env(CBB_EDA_SCRIPT_DIR) ne ""} { set script_dir $::env(CBB_EDA_SCRIPT_DIR) }',
    'proc cbb_eda_path {relative} { global script_dir; if {[info exists ::env(CBB_EDA_SCRIPT_DIR)] && $::env(CBB_EDA_SCRIPT_DIR) ne ""} { return [file join $script_dir $relative] }; return [file normalize [file join $script_dir $relative]] }',
    'if {[file exists work]} { vdel -all -lib work }',
    'vlib work',
    ...rtlSources.map((source) => `vlog -sv -lint -work work [cbb_eda_path {${source}}]`),
    ...svaSources.map((source) => `vlog -sv -work work [cbb_eda_path {${source}}]`),
    tbModule ? `vlog -sv -work work [cbb_eda_path {../${slash(tbSource.path)}}]` : '# ERROR: TB module could not be derived',
    tbModule ? `vsim -c work.${tbModule} -do {run -all; quit -code 0}` : '# ERROR: vsim runtime cannot start without a TB module',
  ].join('\n') + '\n';
  const vivadoTcl = [
    '# Generated by extract-cbb.cjs; run only in an authorized Vivado environment.',
    'set script_dir [file dirname [info script]]',
    'if {[info exists ::env(CBB_EDA_SCRIPT_DIR)] && $::env(CBB_EDA_SCRIPT_DIR) ne ""} { set script_dir $::env(CBB_EDA_SCRIPT_DIR) }',
    'proc cbb_eda_path {relative} { global script_dir; return [file join $script_dir $relative] }',
    `set part [lindex $argv 0]`,
    `if {$part eq ""} { error "part argument is required" }`,
    `create_project -in_memory ${manifest.asset_uid}`,
    `set_property part $part [current_project]`,
    ...rtlSources.map((source) => `read_verilog -sv [cbb_eda_path {${source}}]`),
    ...constraintSources.map((source) => `read_xdc [cbb_eda_path {${source}}]`),
    `synth_design -top ${quoteTcl(manifest.top || manifest.name)} -part $part`,
    `set synth_meta [open synth-meta.json w]`,
    `puts $synth_meta [format {{"asset_uid":"${manifest.asset_uid}","top":"${manifest.top || manifest.name}","part":"%s","stage":"synth_design"}} $part]`,
    `close $synth_meta`,
    `report_utilization -file utilization.rpt`,
    `report_timing_summary -file timing-summary.rpt`,
    `report_clocks -file clocks.rpt`,
    `write_checkpoint -force post_synth.dcp`,
    'close_project',
  ].join('\n') + '\n';
  const cdc = structuralCdcAudit(pkg.abs, manifest);
  const edaManifest = {
    schema_version: '1.0',
    asset_uid: manifest.asset_uid,
    version: manifest.version,
    generated_by: 'extract-cbb.cjs',
    commands: {
      probe: ['vlog -version', 'vsim -version', 'vivado -version'],
      modelsim_sva: 'vsim -c -do eda/modelsim_sva.do',
      vivado: 'vivado -mode batch -source eda/vivado_cert.tcl -tclargs <part>',
      cdc: 'structural audit plus authorized CDC tool report when multiple clocks/primitives exist',
    },
    required_artifacts: ['G-SVA-RUNTIME.json', 'synth-meta.json', 'utilization.rpt', 'timing-summary.rpt', 'clocks.rpt', 'cdc-report.json'],
    cdc_contract: cdc,
    fail_closed: true,
  };
  const readme = [
    `# External EDA certification package: ${manifest.asset_uid}@${manifest.version}`,
    '',
    'This package is deterministic and fail-closed. It is a recipe and artifact contract, not evidence of execution.',
    '',
    '## Commands',
    '- Probe: `node engineering-assets/tools/extract-cbb.cjs probe-eda --root engineering-assets --candidate <package>`.',
    '- ModelSim SVA: from the package/evidence working directory run `vsim -c -do <package>/eda/modelsim_sva.do`; retain exit code and `G-SVA-RUNTIME.json`.',
    '- Vivado: from the package/evidence working directory run `vivado -mode batch -source <package>/eda/vivado_cert.tcl -tclargs <part>`; retain `synth-meta.json`, timing/utilization/clocks artifacts.',
    '- CDC: retain `cdc-report.json`; the current structural result is explicit NA only when one clock and no CDC primitive are present.',
    '',
    'Missing executable, license, runtime exit, or expected artifact is `blocked`; never convert it to pass.',
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(edaDir, 'modelsim_sva.do'), modelSimDo, 'utf8');
  fs.writeFileSync(path.join(edaDir, 'vivado_cert.tcl'), vivadoTcl, 'utf8');
  writeJson(path.join(edaDir, 'eda-manifest.json'), edaManifest);
  writeJson(path.join(edaDir, 'structural-cdc-check.json'), cdc);
  fs.writeFileSync(path.join(edaDir, 'README.md'), readme, 'utf8');
  if (options.updateManifest) {
    const manifestFile = path.join(pkg.abs, 'manifest.json');
    const updated = readJson(manifestFile);
    const add = [
      ['eda/README.md', 'doc'], ['eda/modelsim_sva.do', 'sim'], ['eda/vivado_cert.tcl', 'harness'],
      ['eda/eda-manifest.json', 'harness'], ['eda/structural-cdc-check.json', 'doc'],
    ];
    const existing = new Set((updated.sources || []).map((source) => source.path));
    for (const [file, role] of add) if (!existing.has(file)) updated.sources.push({ path: file, role, sha256: sha256(path.join(pkg.abs, file)), note: 'Deterministic external certification recipe; execution evidence is separate.' });
    for (const source of updated.sources) if (fs.existsSync(path.join(pkg.abs, source.path))) source.sha256 = sha256(path.join(pkg.abs, source.path));
    const blockedManifest = blockReason(manifestFile);
    if (blockedManifest) throw new Error(`[protected-write] ${blockedManifest}`);
    fs.writeFileSync(manifestFile, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
  }
  return { package: pkg.rel, files: ['eda/README.md', 'eda/modelsim_sva.do', 'eda/vivado_cert.tcl', 'eda/eda-manifest.json', 'eda/structural-cdc-check.json'], cdc };
}

function collectEda(root, candidate, options = {}) {
  const pkg = resolveCandidate(root, candidate);
  const { manifest } = readManifest(pkg.abs);
  const edaDir = path.join(pkg.abs, 'eda');
  if (!fs.existsSync(path.join(edaDir, 'eda-manifest.json'))) throw new Error('EDA package missing; run prepare-eda first');
  const probes = probeEdaTools(pkg.abs, { installRoots: options.installRoots || [], vivadoRoot: options.vivadoRoot });
  const cdc = structuralCdcAudit(pkg.abs, manifest);
  const existingProbe = path.join(root, 'var', 'gates', 'pg', manifest.asset_uid, 'G-EDA-PROBE.json');
  if (!options.run && options.useExistingEvidence && fs.existsSync(existingProbe)) return readJson(existingProbe);
  const blockers = [];
  if (probes.modelsim_vlog.status !== 'available' || probes.modelsim_vsim.status !== 'available') {
    blockers.push(probes.policy.failure.category === 'path-not-tested'
      ? 'ModelSim status withheld: recursively scan the user-named installation root before blaming the environment'
      : `ModelSim unavailable: vlog=${probes.modelsim_vlog.status}, vsim=${probes.modelsim_vsim.status}`);
  }
  const vivadoOfficialReady = probes.vivado_launcher && probes.vivado_launcher.path_tested && probes.vivado_launcher.missing_scripts.length === 0 && probes.vivado_launcher.missing_executables.length === 0;
  if (probes.vivado.status !== 'available' && !vivadoOfficialReady) {
    blockers.push(probes.policy.failure.category === 'path-not-tested'
      ? 'Vivado status withheld: recursively scan the user-named installation root before blaming the environment'
      : `Vivado unavailable: ${probes.vivado.status}`);
  }
  if (cdc.status === 'blocked') blockers.push('CDC structural scan requires external CDC evidence');
  const result = { schema_version: '1.0', asset_uid: manifest.asset_uid, version: manifest.version, probes, cdc, blockers, status: blockers.length ? 'blocked' : 'ready-to-run', fail_closed: true };
  const evidenceDir = path.join(root, 'var', 'gates', 'pg', manifest.asset_uid);
  fs.mkdirSync(evidenceDir, { recursive: true });
  const writeEvidence = options.writeEvidence !== false;
  if (writeEvidence) {
    writeJson(path.join(evidenceDir, 'G-EDA-PROBE.json'), result);
    writeJson(path.join(evidenceDir, 'cdc-report.json'), cdc);
  }
  if (options.run) {
    const logDir = path.join(root, 'var', 'build', 'eda', manifest.asset_uid);
    fs.mkdirSync(logDir, { recursive: true });
    result.runs = {};
    if (probes.modelsim_vlog.status === 'available' && probes.modelsim_vsim.status === 'available') {
      const vsim = cp.spawnSync('vsim', ['-c', '-do', path.join(edaDir, 'modelsim_sva.do')], { cwd: logDir, encoding: 'utf8', timeout: 120000, windowsHide: true });
      const vsimOutput = `${vsim.stdout || ''}${vsim.stderr || ''}`;
      fs.writeFileSync(path.join(logDir, 'modelsim.stdout.log'), vsimOutput, 'utf8');
      result.runs.modelsim = { exit_code: vsim.status, status: vsim.status === 0 ? 'pass' : 'blocked', output: vsimOutput.slice(0, 6000) };
      if (vsim.status !== 0) result.blockers.push(`ModelSim runtime exit=${vsim.status}`);
      if (writeEvidence) writeJson(path.join(evidenceDir, 'G-SVA-RUNTIME.json'), result.runs.modelsim);
    } else {
      result.runs.modelsim = { status: 'blocked', reason: 'ModelSim probe unavailable' };
    }
    if (vivadoOfficialReady) {
      const vivadoPart = options.part || manifest.device?.part;
      if (!vivadoPart) {
        result.runs.vivado = { status: 'blocked', reason: 'Vivado run requires --part or manifest.device.part' };
        result.blockers.push('Vivado part is not declared');
      } else {
        const vivado = officialVivadoRun(probes.vivado_launcher.root, ['-mode', 'batch', '-nolog', '-nojournal', '-notrace', '-source', path.join(edaDir, 'vivado_cert.tcl'), '-tclargs', vivadoPart], evidenceDir, { bootstrapRoot: path.join(logDir, 'vivado-appdata') });
        fs.writeFileSync(path.join(logDir, 'vivado.stdout.log'), vivado.output, 'utf8');
        result.runs.vivado = { command: vivado.command, args: vivado.args, launcher_chain: vivado.launcher_chain, bootstrap_root: vivado.bootstrap_root, exit_code: vivado.exit_code, status: vivado.status === 'available' ? 'pass' : 'blocked', output: vivado.output };
        const vivadoFailure = classifyVivadoRunFailure(vivado.exit_code, vivado.output);
        result.runs.vivado.failure_category = vivadoFailure.category;
        result.runs.vivado.failure_reason = vivadoFailure.reason;
        result.probes.policy.failure = classifyEdaFailure({
          actualPathTested: true,
          config: 'pass',
          launcher: vivadoFailure.category === 'launcher-failure' ? 'failed' : 'pass',
          license: vivadoFailure.category === 'license-checkout-failure' ? 'failed' : 'pass',
          execution: vivadoFailure.category === 'tool-execution-failure' ? 'failed' : 'pass',
        });
        if (vivado.status !== 'available') result.blockers.push(`Vivado ${vivadoFailure.category} exit=${vivado.exit_code ?? vivado.status}`);
      }
    } else result.runs.vivado = { status: 'blocked', reason: probes.vivado_launcher ? `Vivado official launcher contract=${probes.vivado_launcher.status}` : 'Vivado official launcher path was not supplied' };
    result.status = result.blockers.length ? 'blocked' : 'pass';
    if (writeEvidence) writeJson(path.join(evidenceDir, 'G-EDA-PROBE.json'), result);
  }
  return result;
}

function planCleanup(ledger, paths) {
  const removable = []; const rejected = [];
  const sourceProtected = (ledger.source_paths || []).map(slash);
  const finalProtected = (ledger.final_evidence_paths || []).map(slash);
  for (const raw of paths) {
    const item = slash(raw);
    const under = (base) => item === base || item.startsWith(`${base}/`);
    if (sourceProtected.some(under) || under(slash(ledger.candidate_path))) { rejected.push(`${item}: protected source/package`); continue; }
    if (finalProtected.some(under) || item.includes('/evidence/') || item.startsWith('evidence/')) { rejected.push(`${item}: protected final evidence`); continue; }
    if (!TEMP_ROOTS.some((root) => item === root || item.startsWith(`${root}/`))) { rejected.push(`${item}: outside approved temporary roots`); continue; }
    removable.push(item);
  }
  if (rejected.length) throw new Error(rejected.join('; '));
  return { removable: [...new Set(removable)].sort(), rejected: [] };
}

function executeCleanup(root, ledger, paths) {
  const plan = planCleanup(ledger, paths);
  for (const item of plan.removable) {
    const abs = path.resolve(root, item);
    if (fs.existsSync(abs)) fs.rmSync(abs, { recursive: true, force: false });
  }
  ledger.cleanup.removable = plan.removable;
  ledger.cleanup.rejected = [];
  return ledger;
}

function runNodeTool(root, tool, args) {
  const repoRoot = path.dirname(root);
  const result = cp.spawnSync(process.execPath, [path.join(root, 'tools', tool), ...args], { cwd: repoRoot, encoding: 'utf8', timeout: 120000, windowsHide: true });
  return { tool, args, exit_code: result.status, status: result.status === 0 ? 'pass' : 'fail', output: `${result.stdout || ''}${result.stderr || ''}`.slice(0, 6000) };
}

function runCandidatePipeline(root, candidate, options = {}) {
  const scan = scanCandidate(root, candidate);
  const manifest = scan.manifest;
  const ledger = createLedger(manifest.asset_uid, scan.candidate_path, {
    sourcePaths: (manifest.sources || []).map((source) => slash(path.join(scan.candidate_path, source.path))),
    finalEvidencePaths: [`evidence/${manifest.asset_uid}/${manifest.version}`, `var/gates/pg/${manifest.asset_uid}`],
  });
  const pipelineDir = path.join(root, 'var', 'cbb', 'pipeline', manifest.asset_uid);
  fs.mkdirSync(pipelineDir, { recursive: true });
  const intakePath = path.join(pipelineDir, 'intake.json');
  writeJson(intakePath, scan);
  setStage(ledger, 'source_scan_intake', 'pass', [slash(path.relative(root, intakePath))]);
  setStage(ledger, 'classification', scan.classification.category === 'permanent-delete candidate' ? 'blocked' : 'pass', [slash(path.relative(root, intakePath))], scan.classification.reason);
  const pkgDir = path.join(root, scan.candidate_path);
  const provenance = captureProvenance(pkgDir, manifest);
  if (provenance.status === 'pass') {
    ledger.provenance = provenance.record;
    setStage(ledger, 'provenance_license', 'pass', provenance.evidence);
  } else setStage(ledger, 'provenance_license', 'blocked', provenance.evidence, provenance.error);
  const required = requiredPackageFiles(pkgDir, manifest);
  if (!required.missing.length && !required.missingSources.length && fs.readFileSync(path.join(pkgDir, 'docs', 'requirements.md'), 'utf8').includes('## Contract')) setStage(ledger, 'requirements', 'pass', [slash(path.join(scan.candidate_path, 'docs/requirements.md'))]);
  else setStage(ledger, 'requirements', 'blocked', [slash(path.join(scan.candidate_path, 'docs/requirements.md'))], `missing=${[...required.missing, ...required.missingSources].join(',') || 'contract section'}`);
  const rtl = (manifest.sources || []).filter((source) => source.role === 'rtl');
  if (rtl.length && rtl.every((source) => fs.existsSync(path.join(pkgDir, source.path)))) setStage(ledger, 'normalized_rtl', 'pass', rtl.map((source) => slash(path.join(scan.candidate_path, source.path))));
  else setStage(ledger, 'normalized_rtl', 'blocked', [], 'declared RTL source is missing');
  const model = manifest.golden_model_ref && fs.existsSync(path.join(pkgDir, 'model'));
  if (model) setStage(ledger, 'golden_reference', 'pass', [slash(path.join(scan.candidate_path, 'model'))]);
  else setStage(ledger, 'golden_reference', 'blocked', [], 'independent model directory or golden_model_ref missing');
  const sva = (manifest.sources || []).some((source) => /sva/i.test(source.path)) && fs.existsSync(path.join(pkgDir, 'sva'));
  if (sva) setStage(ledger, 'reusable_sva', 'pass', [slash(path.join(scan.candidate_path, 'sva'))]);
  else setStage(ledger, 'reusable_sva', 'blocked', [], 'reusable SVA source missing');
  const randomized = fs.existsSync(path.join(pkgDir, 'tb')) && fs.existsSync(path.join(pkgDir, 'model')) && fs.existsSync(path.join(pkgDir, 'docs', 'verification.md'));
  if (randomized) setStage(ledger, 'randomized_verification', 'pass', [slash(path.join(scan.candidate_path, 'tb')), slash(path.join(scan.candidate_path, 'docs/verification.md'))]);
  else setStage(ledger, 'randomized_verification', 'blocked', [], 'TB/model/verification documentation missing');

  const gateCandidate = slash(path.join(path.basename(root), scan.candidate_path));
  const gateRun = runNodeTool(root, 'gate-runner.cjs', [gateCandidate, '--repo-root', path.dirname(root)]);
  const gateEvidence = path.join(root, 'var', 'gates', 'pg', manifest.asset_uid, 'gate-results.json');
  const snapshot = path.join(root, 'evidence', manifest.asset_uid, manifest.version, 'SNAPSHOT.json');
  if (gateRun.exit_code <= 1 && fs.existsSync(gateEvidence) && fs.existsSync(snapshot)) setStage(ledger, 'lint_gate_snapshot', 'pass', [slash(path.relative(root, gateEvidence)), slash(path.relative(root, snapshot))]);
  else setStage(ledger, 'lint_gate_snapshot', 'blocked', [slash(path.relative(root, gateEvidence))], `gate_exit=${gateRun.exit_code}; snapshot=${fs.existsSync(snapshot) ? 'present' : 'missing'}`);
  writeJson(path.join(pipelineDir, 'gate-run.json'), gateRun);

  const edaPackage = prepareEdaPackage(root, scan.candidate_path, { updateManifest: false });
  const eda = collectEda(root, scan.candidate_path, { run: options.runEda === true, useExistingEvidence: options.runEda !== true, writeEvidence: options.runEda === true, part: options.part, installRoots: options.installRoots || [], vivadoRoot: options.vivadoRoot });
  ledger.external = { probes: eda.probes, blockers: eda.blockers, cdc: eda.cdc };
  setStage(ledger, 'eda_certification_package', 'pass', edaPackage.files.map((file) => slash(path.join(scan.candidate_path, file))));
  const localStageIds = REQUIRED_STAGES.filter((id) => !['qualification_decision', 'temporary_cleanup', 'catalog_audit_update'].includes(id));
  const localReady = localStageIds.every((id) => ['pass', 'na'].includes(stageById(ledger, id).status));
  setStage(ledger, 'temporary_cleanup', 'na', [], 'No deletion is performed by a qualification run. Any cleanup must use the exact temporary-root allowlist and source/final-evidence guard.', 'lihan');

  const catalogRun = runNodeTool(root, 'catalog-gen.cjs', ['--root', root, '--write', '--write-readme']);
  const knowledgeRun = runNodeTool(root, 'knowledge-index.cjs', ['--root', root, '--write']);
  const auditRun = runNodeTool(root, 'asset-audit.cjs', ['--root', root]);
  const lineageRun = runNodeTool(root, 'lineage-check.cjs', ['--root', root]);
  // The previous ledger may contain a blocked decision from an interrupted run.
  // Ignore pipeline self-errors for this in-flight maintenance pass; a normal
  // maintenance check runs again after the new final ledger is written below.
  const maintenanceWrite = runNodeTool(root, 'maintenance-check.cjs', ['--root', root, '--write', '--allow-inflight']);
  const maintenanceCheck = runNodeTool(root, 'maintenance-check.cjs', ['--root', root, '--check', '--allow-inflight']);
  const catalogOk = [catalogRun, knowledgeRun, auditRun, lineageRun, maintenanceWrite, maintenanceCheck].every((item) => item.exit_code === 0);
  setStage(ledger, 'catalog_audit_update', catalogOk ? 'pass' : 'blocked', [slash(path.relative(root, path.join(root, 'catalog', 'catalog.json'))), slash(path.relative(root, path.join(root, 'var', 'audit', 'maintenance-report.json')))], catalogOk ? null : 'one or more catalog/audit/maintenance commands failed');

  const coreReady = localReady && catalogOk && ['pass', 'na'].includes(stageById(ledger, 'temporary_cleanup').status);
  if (coreReady) {
    setStage(ledger, 'qualification_decision', 'pass', [slash(path.relative(root, path.join(pipelineDir, 'stage-ledger.json')))], 'All local required stages passed; external EDA blockers remain explicit in ledger.external.');
    ledger.decision = { level: 'qualification', certified: false, local_prerequisites: 'pass', certification_blockers: eda.blockers, rationale: 'Qualification is the highest honest level until genuine external EDA artifacts and signoff exist.' };
  } else {
    setStage(ledger, 'qualification_decision', 'blocked', [], 'At least one required local stage is unresolved; no qualification decision may be issued.');
    ledger.decision = { level: 'blocked', certified: false, local_prerequisites: 'blocked', blockers: ledger.stages.filter((item) => item.status === 'blocked' || item.status === 'fail').map((item) => `${item.id}=${item.status}`), certification_blockers: eda.blockers };
  }
  const provisionalOut = writeLedger(root, ledger);
  // A workspace may contain another candidate's prior in-flight ledger while
  // candidates are processed serially.  Keep this candidate's own catalog,
  // audit, lineage, and snapshot checks strict; the normal whole-workspace
  // maintenance check runs after all candidate pipelines finish.
  const finalMaintenanceWrite = runNodeTool(root, 'maintenance-check.cjs', ['--root', root, '--write', '--allow-inflight']);
  const finalMaintenanceCheck = runNodeTool(root, 'maintenance-check.cjs', ['--root', root, '--check', '--allow-inflight']);
  if (coreReady && (finalMaintenanceWrite.exit_code !== 0 || finalMaintenanceCheck.exit_code !== 0)) {
    setStage(ledger, 'catalog_audit_update', 'blocked', [slash(path.relative(root, path.join(root, 'var', 'audit', 'maintenance-report.json')))], 'final maintenance check failed after ledger write');
    setStage(ledger, 'qualification_decision', 'blocked', [], 'Final maintenance check failed; no qualification decision may be issued.');
    ledger.decision = { level: 'blocked', certified: false, local_prerequisites: 'blocked', blockers: ['catalog_audit_update=blocked', 'qualification_decision=blocked'], certification_blockers: eda.blockers };
  }
  writeJson(path.join(pipelineDir, 'catalog-audit-commands.json'), { catalogRun, knowledgeRun, auditRun, lineageRun, maintenanceWrite, maintenanceCheck, finalMaintenanceWrite, finalMaintenanceCheck });
  const out = writeLedger(root, ledger);
  return { ledger, output: slash(path.relative(root, out)) };
}

function writeLedger(root, ledger) {
  const out = path.join(root, 'var', 'cbb', 'pipeline', ledger.asset_uid, 'stage-ledger.json');
  writeJson(out, ledger);
  return out;
}

function usage() {
  return 'extract-cbb.cjs assess|scan|run|prepare-eda|probe-eda|collect-eda|cleanup --root <repository-or-engineering-assets> --candidate <path> [--install-root <user-named-install-root>] [--vivado-root <Vivado-install-root>]';
}

function optionValues(argv, name) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) if (argv[index] === name && argv[index + 1]) values.push(argv[index + 1]);
  return values;
}

function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  const rootIndex = argv.indexOf('--root');
  const candidateIndex = argv.indexOf('--candidate');
  const root = path.resolve(rootIndex >= 0 ? argv[rootIndex + 1] : path.resolve(__dirname, '..'));
  const candidate = candidateIndex >= 0 ? argv[candidateIndex + 1] : null;
  try {
    if (!command || !['assess', 'scan', 'run', 'prepare-eda', 'probe-eda', 'collect-eda', 'cleanup'].includes(command)) throw new Error(usage());
    if (command === 'assess') {
      if (!candidate) throw new Error('--candidate is required');
      const result = assessCandidate(root, candidate);
      const uid = path.basename(candidate).replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9_]+/g, '_');
      const engineeringRoot = fs.existsSync(path.join(root, 'engineering-assets')) ? path.join(root, 'engineering-assets') : root;
      const out = path.join(engineeringRoot, 'var', 'cbb', 'pipeline', 'intake-assessments', `${uid}.json`);
      writeJson(out, result);
      console.log(JSON.stringify({ output: slash(path.relative(engineeringRoot, out)), decision: result.decision, blockers: result.blockers }, null, 2));
      return result.decision === 'blocked' ? 1 : 0;
    }
    if (command === 'scan') {
      const result = candidate ? scanCandidate(root, candidate) : scanRepository(root);
      const out = path.join(root, 'var', 'cbb', 'pipeline', candidate ? result.manifest.asset_uid : 'repository', candidate ? 'intake.json' : 'inventory.json');
      writeJson(out, result);
      console.log(JSON.stringify({ status: 'pass', output: slash(path.relative(root, out)), candidate: candidate || null, files: candidate ? result.package_files.length : result.file_count }));
      return 0;
    }
    if (!candidate) throw new Error('--candidate is required');
    const installRoots = optionValues(argv, '--install-root');
    const vivadoRoot = argv.includes('--vivado-root') ? argv[argv.indexOf('--vivado-root') + 1] : undefined;
    if (command === 'run') { const result = runCandidatePipeline(root, candidate, { runEda: argv.includes('--run-eda'), part: argv[argv.indexOf('--part') + 1], installRoots, vivadoRoot }); console.log(JSON.stringify({ output: result.output, decision: result.ledger.decision }, null, 2)); return result.ledger.decision.level === 'blocked' ? 1 : 0; }
    if (command === 'prepare-eda') { const result = prepareEdaPackage(root, candidate, { updateManifest: argv.includes('--update-manifest') }); console.log(JSON.stringify(result)); return 0; }
    if (command === 'probe-eda') { console.log(JSON.stringify(probeEdaTools(resolveCandidate(root, candidate).abs, { installRoots, vivadoRoot }), null, 2)); return 0; }
    if (command === 'collect-eda') { const result = collectEda(root, candidate, { run: argv.includes('--run'), part: argv[argv.indexOf('--part') + 1], installRoots, vivadoRoot }); console.log(JSON.stringify(result, null, 2)); return result.status === 'pass' ? 0 : 1; }
    if (command === 'cleanup') {
      const pkg = resolveCandidate(root, candidate); const { manifest } = readManifest(pkg.abs);
      const ledgerFile = path.join(root, 'var', 'cbb', 'pipeline', manifest.asset_uid, 'stage-ledger.json');
      if (!fs.existsSync(ledgerFile)) throw new Error('stage ledger missing');
      const ledger = readJson(ledgerFile); const values = argv.slice(argv.indexOf('--paths') + 1).filter((item) => !item.startsWith('--'));
      if (!argv.includes('--execute')) { console.log(JSON.stringify(planCleanup(ledger, values), null, 2)); return 0; }
      writeLedger(root, executeCleanup(root, ledger, values)); console.log(JSON.stringify({ status: 'pass', removed: values })); return 0;
    }
    return 2;
  } catch (error) { console.error(`[extract-cbb] ${error.message}`); return 2; }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  REQUIRED_STAGES,
  assessCandidate,
  TEMP_ROOTS,
  captureProvenance,
  classifyEdaFailure,
  classifyVivadoRunFailure,
  buildVivadoBatchCommand,
  discoverVivadoLauncher,
  classifyPath,
  collectEda,
  createLedger,
  discoverInstallRoot,
  decideQualification,
  executeCleanup,
  main,
  planCleanup,
  prepareEdaPackage,
  probeEdaTools,
  runCandidatePipeline,
  scanCandidate,
  scanRepository,
  setStage,
  structuralCdcAudit,
  officialVivadoRun,
  validateLedger,
};
