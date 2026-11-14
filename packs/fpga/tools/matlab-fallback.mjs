#!/usr/bin/env node
/**
 * matlab-fallback.mjs
 * Unified API for MATLAB availability verification and Python fallback guidance.
 *
 * Usage:
 *   node matlab-fallback.mjs                   # Quick check, JSON output
 *   node matlab-fallback.mjs --check           # Same as above
 *   node matlab-fallback.mjs --guide           # Print fallback guidance
 *   node matlab-fallback.mjs --all             # Check + guidance
 *
 * Import from another module:
 *   import { checkMatlab, getGuide } from './matlab-fallback.mjs';
 *   const status = await checkMatlab();
 *   // => { matlab_available: boolean, version: string|null, error: string|null }
 */

import { execFile, exec } from 'child_process';
import { accessSync, constants } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MATLAB_PATHS = [
  'C:\\Program Files\\MATLAB\\R2022a\\bin\\matlab.exe',
  'C:\\Program Files\\MATLAB\\R2023a\\bin\\matlab.exe',
  'C:\\Program Files\\MATLAB\\R2023b\\bin\\matlab.exe',
  'C:\\Program Files\\MATLAB\\R2024a\\bin\\matlab.exe',
  'C:\\Program Files\\MATLAB\\R2024b\\bin\\matlab.exe',
];

const TEST_SCRIPT = resolve(__dirname, '..', 'test_matlab_mcp.m');

/**
 * Check if a file exists and is accessible.
 * @param {string} filePath
 * @returns {boolean}
 */
function fileExists(filePath) {
  try {
    accessSync(filePath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find MATLAB executable on the system.
 * @returns {string|null} Path to MATLAB executable or null.
 */
export function findMatlab() {
  // 1) Well-known install paths
  for (const p of MATLAB_PATHS) {
    if (fileExists(p)) return p;
  }

  // 2) PATH search
  const pathDirs = (process.env.PATH || '').split(/[;:]/);
  for (const dir of pathDirs) {
    for (const ext of ['matlab.exe', 'matlab.bat']) {
      const candidate = resolve(dir, ext);
      if (fileExists(candidate)) return candidate;
    }
  }

  return null;
}

/**
 * Get MATLAB version string.
 * @param {string} matlabExe
 * @returns {Promise<string|null>}
 */
function getMatlabVersion(matlabExe) {
  return new Promise((resolvePromise) => {
    execFile(matlabExe, ['-batch', 'version'], {
      timeout: 30000,
      windowsHide: true,
    }, (err, stdout) => {
      if (!err && stdout) {
        resolvePromise(stdout.trim());
        return;
      }
      // Fallback: -nodisplay
      execFile(matlabExe, ['-nodisplay', '-nosplash', '-r', 'version, exit'], {
        timeout: 30000,
        windowsHide: true,
      }, (err2, stdout2) => {
        resolvePromise(err2 ? null : (stdout2.trim() || null));
      });
    });
  });
}

/**
 * Check MATLAB availability by running the test script.
 * @returns {Promise<{matlab_available: boolean, version: string|null, error: string|null, matlab_path: string|null}>}
 */
export async function checkMatlab() {
  const result = {
    matlab_available: false,
    version: null,
    error: null,
    matlab_path: null,
  };

  const matlabExe = findMatlab();
  if (!matlabExe) {
    result.error = 'MATLAB executable not found. Checked well-known install paths and PATH.';
    return result;
  }

  result.matlab_path = matlabExe;

  // Get version
  result.version = await getMatlabVersion(matlabExe);

  // Run test script
  try {
    const { stdout, stderr, exitCode } = await runTest(matlabExe);
    if (exitCode === 0 && stdout.includes('MATLAB MCP OK')) {
      result.matlab_available = true;
    } else {
      let errMsg = `Test script failed with exit code ${exitCode}`;
      if (stderr) errMsg += `: ${stderr.trim()}`;
      if (!stdout.includes('MATLAB MCP OK') && stdout) {
        errMsg += ` (stdout did not contain expected marker)`;
      }
      result.error = errMsg;
    }
  } catch (err) {
    result.error = `Test script execution failed: ${err.message}`;
  }

  return result;
}

/**
 * Run the MATLAB test script.
 * @param {string} matlabExe
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number}>}
 */
function runTest(matlabExe) {
  return new Promise((resolvePromise) => {
    execFile(matlabExe, [
      '-batch',
      `run('${TEST_SCRIPT.replace(/\\/g, '/')}')`,
    ], {
      timeout: 60000,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      if (err && stderr && stderr.includes('unrecognized option')) {
        // -batch not supported, fallback
        execFile(matlabExe, [
          '-nodisplay', '-nosplash',
          '-r', `run('${TEST_SCRIPT.replace(/\\/g, '/')}'), exit`,
        ], {
          timeout: 60000,
          windowsHide: true,
        }, (err2, stdout2, stderr2) => {
          resolvePromise({
            stdout: stdout2 || '',
            stderr: stderr2 || '',
            exitCode: err2 ? (err2.code || 1) : 0,
          });
        });
      } else {
        resolvePromise({
          stdout: stdout || '',
          stderr: stderr || '',
          exitCode: err ? (err.code || 1) : 0,
        });
      }
    });
  });
}

/**
 * Get fallback guidance markdown text.
 * @returns {string}
 */
export function getGuide() {
  return `
╔══════════════════════════════════════════════════════════════╗
║            MATLAB is NOT available on this system            ║
╚══════════════════════════════════════════════════════════════╝

MATLAB was not found at any of the expected paths:
  ${MATLAB_PATHS.map(p => `- ${p}`).join('\n  ')}

What this means:
  - Golden Model verification via MATLAB is not possible
  - MCP tools depending on MATLAB will not work
  - All golden model work MUST use Python instead

Python as golden model (RECOMMENDED):
  Python is the preferred golden model language because:
  - Cross-platform (Windows/Linux/Mac)
  - Fully scriptable and automatable
  - Git-friendly (text files, diffable)
  - Free and open-source
  - Rich numerical libraries (numpy, scipy)

Directory structure for Python golden models:
  golden_models/<module>/<module>_gm.py

Each golden model module must provide:
  a) Python function implementing the algorithm
  b) Command-line test entry point (if __name__ == '__main__')
  c) Built-in test vectors (known_answer list)
  d) Fixed-point quantization parameter configuration

Reference implementations:
  knowledge/primary/domains/comm/wifi/golden_models/

To install MATLAB (optional):
  Visit: https://www.mathworks.com/downloads/
  The system has a license for MATLAB R2022a.
  Install path: C:\\Program Files\\MATLAB\\R2022a\\bin\\matlab.exe
`.trim();
}

// --- CLI Entry Point ---
async function main() {
  const args = process.argv.slice(2);
  const mode = args[0] || '--check';
  let status = null;

  if (mode === '--check' || mode === '--all') {
    status = await checkMatlab();
    console.log(JSON.stringify(status, null, 2));
  }

  if (mode === '--guide') {
    status = await checkMatlab();
  }

  if (mode === '--guide' || mode === '--all') {
    if (status && status.matlab_available) {
      console.log('\n✅ MATLAB is available. No fallback needed.\n');
    } else {
      console.log('\n' + getGuide() + '\n');
    }
  }

  if (!['--check', '--guide', '--all'].includes(mode)) {
    console.error('Usage: node matlab-fallback.mjs [--check | --guide | --all]');
    process.exit(1);
  }
}

// Only run main when executed directly (not imported)
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(err => {
    console.error('matlab-fallback.mjs error:', err.message);
    process.exit(1);
  });
}
