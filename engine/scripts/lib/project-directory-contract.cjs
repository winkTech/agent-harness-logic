#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CONTRACT_VERSION = 1;

const CORE_PROJECT_DIRS = Object.freeze([
  '00_comm',
  '01_src/00_hdl',
  '01_src/00_hdl/00_com',
  '01_src/01_ip',
  '01_src/01_ip/00_clk',
  '01_src/01_ip/01_mem',
  '01_src/01_ip/02_dsp',
  '01_src/01_ip/03_comm',
  '02_sim',
  '02_sim/tv',
  '02_sim/check_results',
  '03_xdc',
  '04_prj',
  '05_bin',
  '06_doc',
  '07_mat',
  '07_mat/00_fx',
  '07_mat/01_conf',
  '07_mat/02_script',
  '08_py',
  'scripts',
  'memory',
  'var/gates',
  'var/project-init',
]);

const REQUIRED_ROOT_FILES = Object.freeze([
  'Makefile',
  '.gitignore',
  'README.md',
]);

const CONTRACT_FILE = path.join('var', 'project-init', 'directory-contract.json');

const FORBIDDEN_TOP_LEVEL_DIRS = Object.freeze([
  'rtl',
  'tb',
  'testbench',
  'constraints',
  'constraint',
  'build',
  'reports',
  'report',
  'sim',
  'src',
  'docs',
]);

const ROOT_TRANSIENT_PATTERNS = Object.freeze([
  /^transcript$/i,
  /^vsim\.wlf$/i,
  /^vivado.*\.(log|jou)$/i,
  /^xsim\.(log|jou|tcl)$/i,
  /\.(vcd|vcd\.lxt|wlf|wlftmp|wdb|vvp|dcp|rpt|jou|log)$/i,
]);

function normalizeRel(relPath) {
  return String(relPath || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/');
}

function normalizeAbs(filePath) {
  return path.resolve(filePath).replace(/\\/g, '/').toLowerCase();
}

function isInsideDir(filePath, dir) {
  const fileNorm = normalizeAbs(filePath);
  const dirNorm = normalizeAbs(dir);
  return fileNorm === dirNorm || fileNorm.startsWith(`${dirNorm}/`);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function modulePaths(moduleName) {
  const mod = String(moduleName || '').trim();
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(mod)) {
    throw new Error(`invalid module name: ${moduleName}`);
  }
  return {
    rtlDir: path.join('01_src', '00_hdl', mod),
    rtl: path.join('01_src', '00_hdl', mod, `${mod}.sv`),
    simDir: path.join('02_sim', mod),
    tb: path.join('02_sim', mod, `tb_${mod}.sv`),
    check: path.join('02_sim', mod, `check_${mod}.py`),
    checkResult: path.join('02_sim', 'check_results', `${mod}.json`),
  };
}

function allDirsForModules(modules = []) {
  const dirs = [...CORE_PROJECT_DIRS];
  for (const moduleName of modules) {
    const p = modulePaths(moduleName);
    dirs.push(p.rtlDir, p.simDir);
  }
  return [...new Set(dirs.map(normalizeRel))];
}

function ensureProjectDirs(rootDir, options = {}) {
  const root = path.resolve(rootDir);
  const dirs = allDirsForModules(options.modules || []);
  ensureDir(root);
  for (const rel of dirs) ensureDir(path.join(root, rel));
  return dirs.map((rel) => path.join(root, rel));
}

function writeDirectoryContract(rootDir, options = {}) {
  const root = path.resolve(rootDir);
  ensureDir(path.join(root, 'var', 'project-init'));
  const contract = {
    schemaVersion: CONTRACT_VERSION,
    projectName: options.projectName || path.basename(root),
    createdAt: options.createdAt || new Date().toISOString(),
    layout: 'hdl-root-v1',
    rootStyle: 'project-root-directories',
    requiredDirs: allDirsForModules(options.modules || []),
    requiredRootFiles: [...REQUIRED_ROOT_FILES],
    modulePathTemplate: {
      rtl: '01_src/00_hdl/<module>/<module>.sv',
      testbench: '02_sim/<module>/tb_<module>.sv',
      check: '02_sim/<module>/check_<module>.py',
      checkResult: '02_sim/check_results/<module>.json',
      xdc: '03_xdc/<name>.xdc',
    },
    forbiddenTopLevelDirs: [...FORBIDDEN_TOP_LEVEL_DIRS],
    transientRootFiles: ROOT_TRANSIENT_PATTERNS.map((pattern) => pattern.source),
  };
  fs.writeFileSync(path.join(root, CONTRACT_FILE), `${JSON.stringify(contract, null, 2)}\n`, 'utf8');
  return contract;
}

function readDirectoryContract(rootDir) {
  const filePath = path.join(path.resolve(rootDir), CONTRACT_FILE);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function looksLikeProjectRoot(dir) {
  return fs.existsSync(path.join(dir, CONTRACT_FILE))
    || (
      fs.existsSync(path.join(dir, '01_src', '00_hdl'))
      && fs.existsSync(path.join(dir, '02_sim'))
      && fs.existsSync(path.join(dir, '06_doc'))
    );
}

function findProjectRoot(filePath, cwd = process.cwd()) {
  const absolute = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(cwd || process.cwd(), filePath);
  let dir = fs.existsSync(absolute) && fs.statSync(absolute).isDirectory()
    ? absolute
    : path.dirname(absolute);
  while (dir && dir !== path.dirname(dir)) {
    if (looksLikeProjectRoot(dir)) return dir;
    dir = path.dirname(dir);
  }
  return '';
}

function relativeToRoot(rootDir, filePath, cwd = process.cwd()) {
  const absolute = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(cwd || process.cwd(), filePath);
  return normalizeRel(path.relative(path.resolve(rootDir), absolute));
}

function isTbFile(relPath) {
  return /(?:^|\/)(?:tb_[^/]+|[^/]+_tb)\.(sv|v)$/i.test(normalizeRel(relPath));
}

function isHdlFile(relPath) {
  return /\.(sv|v)$/i.test(relPath);
}

function isXdcFile(relPath) {
  return /\.xdc$/i.test(relPath);
}

function rootTransientViolation(relPath) {
  const rel = normalizeRel(relPath);
  if (rel.includes('/')) return '';
  return ROOT_TRANSIENT_PATTERNS.some((pattern) => pattern.test(rel))
    ? `root transient artifact is forbidden: ${rel}`
    : '';
}

function placementViolations(relPath) {
  const rel = normalizeRel(relPath);
  if (!rel || rel === '.') return [];
  const parts = rel.split('/');
  const top = parts[0].toLowerCase();
  const violations = [];

  const transient = rootTransientViolation(rel);
  if (transient) violations.push(transient);

  if (FORBIDDEN_TOP_LEVEL_DIRS.includes(top)) {
    violations.push(`forbidden top-level directory "${parts[0]}"; use the HDL root layout instead`);
  }

  if (isXdcFile(rel) && parts[0] !== '03_xdc') {
    violations.push(`XDC files must be written under 03_xdc/: ${rel}`);
  }

  if (!isHdlFile(rel)) return violations;

  if (parts[0] === '01_src' && parts[1] === '00_hdl') {
    if (parts.length < 4) {
      violations.push(`RTL files must include a module directory: 01_src/00_hdl/<module>/<file>.sv (${rel})`);
    }
    if (isTbFile(rel)) {
      violations.push(`testbenches must not be written under 01_src/00_hdl/: ${rel}`);
    }
    return violations;
  }

  if (parts[0] === '01_src' && parts[1] === '01_ip') {
    if (isTbFile(rel)) violations.push(`testbenches must not be written under 01_src/01_ip/: ${rel}`);
    return violations;
  }

  if (parts[0] === '02_sim') {
    if (parts.length < 3) {
      violations.push(`simulation HDL must live under 02_sim/<module>/: ${rel}`);
    }
    return violations;
  }

  violations.push(`HDL files must be under 01_src/00_hdl/<module>/ or 02_sim/<module>/: ${rel}`);
  return violations;
}

function walkFiles(rootDir, options = {}) {
  const root = path.resolve(rootDir);
  const ignore = new Set(options.ignoreDirs || ['.git', 'node_modules', '.Xil', 'xsim.dir', 'work']);
  const maxFiles = options.maxFiles || 20000;
  const files = [];
  function visit(dir) {
    if (files.length >= maxFiles) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = normalizeRel(path.relative(root, full));
      if (entry.isDirectory()) {
        if (!ignore.has(entry.name)) visit(full);
      } else if (entry.isFile()) {
        files.push(rel);
      }
    }
  }
  visit(root);
  return files;
}

function validateProjectDirs(rootDir, options = {}) {
  const root = path.resolve(rootDir);
  const failures = [];
  const warnings = [];
  const requiredDirs = allDirsForModules(options.modules || []);

  for (const rel of requiredDirs) {
    if (!fs.existsSync(path.join(root, rel))) failures.push(`missing required directory: ${rel}`);
  }

  if (options.requireRootFiles) {
    for (const rel of REQUIRED_ROOT_FILES) {
      if (!fs.existsSync(path.join(root, rel))) failures.push(`missing required root file: ${rel}`);
    }
  }

  if (fs.existsSync(root)) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const name = entry.name;
      if (entry.isDirectory() && FORBIDDEN_TOP_LEVEL_DIRS.includes(name.toLowerCase())) {
        failures.push(`forbidden top-level directory exists: ${name}/`);
      }
      if (entry.isFile()) {
        const transient = rootTransientViolation(name);
        if (transient) failures.push(transient);
      }
    }
  }

  if (options.scanFiles !== false && fs.existsSync(root)) {
    for (const rel of walkFiles(root, options)) {
      for (const failure of placementViolations(rel)) failures.push(failure);
    }
  }

  return {
    ok: failures.length === 0,
    root,
    requiredDirs,
    failures: [...new Set(failures)],
    warnings,
  };
}

function validateActionPath(filePath, cwd = process.cwd()) {
  const projectRoot = findProjectRoot(filePath, cwd);
  if (projectRoot) {
    const relPath = relativeToRoot(projectRoot, filePath, cwd);
    return {
      ok: placementViolations(relPath).length === 0,
      projectRoot,
      relPath,
      failures: placementViolations(relPath),
    };
  }

  const relPath = normalizeRel(path.isAbsolute(filePath) ? path.basename(filePath) : filePath);
  const failures = placementViolations(relPath)
    .filter((message) => /forbidden top-level|HDL files must|XDC files must|root transient/.test(message));
  if (failures.length > 0) {
    failures.unshift('no HDL directory contract was found; run harness-init/project-init before writing project files');
  }
  return { ok: failures.length === 0, projectRoot: '', relPath, failures };
}

module.exports = {
  CONTRACT_VERSION,
  CONTRACT_FILE,
  CORE_PROJECT_DIRS,
  REQUIRED_ROOT_FILES,
  FORBIDDEN_TOP_LEVEL_DIRS,
  modulePaths,
  ensureProjectDirs,
  writeDirectoryContract,
  readDirectoryContract,
  findProjectRoot,
  relativeToRoot,
  placementViolations,
  validateActionPath,
  validateProjectDirs,
};
