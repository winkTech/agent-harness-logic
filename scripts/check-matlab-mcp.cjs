#!/usr/bin/env node
/**
 * check-matlab-mcp.cjs
 * MATLAB MCP connectivity verification script.
 *
 * Attempts to run MATLAB, captures output and exit code.
 * Outputs JSON: { matlab_available, version, error }
 *
 * Usage: node check-matlab-mcp.cjs
 *        node check-matlab-mcp.cjs --verbose   (includes stdout/stderr in output)
 */

const { execFile, exec } = require('child_process');
const path = require('path');

const MATLAB_PATHS = [
  'C:\\Program Files\\MATLAB\\R2022a\\bin\\matlab.exe',
  'C:\\Program Files\\MATLAB\\R2023a\\bin\\matlab.exe',
  'C:\\Program Files\\MATLAB\\R2023b\\bin\\matlab.exe',
  'C:\\Program Files\\MATLAB\\R2024a\\bin\\matlab.exe',
  'C:\\Program Files\\MATLAB\\R2024b\\bin\\matlab.exe',
];

const TEST_SCRIPT = path.resolve(__dirname, '..', 'test_matlab_mcp.m');

const verbose = process.argv.includes('--verbose');

/**
 * Attempt to find MATLAB executable.
 * @returns {string|null} Path to MATLAB exe, or null if not found.
 */
function findMatlab() {
  // 1) Check well-known install paths
  for (const p of MATLAB_PATHS) {
    try {
      require('fs').accessSync(p);
      return p;
    } catch (_) {
      // not found, keep trying
    }
  }

  // 2) Check PATH for matlab
  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, 'matlab.exe');
    try {
      require('fs').accessSync(candidate);
      return candidate;
    } catch (_) {
      // try with .bat extension
    }
    const batCandidate = path.join(dir, 'matlab.bat');
    try {
      require('fs').accessSync(batCandidate);
      return batCandidate;
    } catch (_) {
      // not found
    }
  }

  // Also check for matlab (no .exe) on Windows via where
  return null;
}

/**
 * Get MATLAB version string by running "matlab -batch 'version'".
 * @param {string} matlabExe
 * @returns {Promise<string>}
 */
function getMatlabVersion(matlabExe) {
  return new Promise((resolve, reject) => {
    execFile(matlabExe, ['-batch', 'version'], {
      timeout: 30000,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      if (err) {
        // Fallback: try -nodisplay approach
        execFile(matlabExe, ['-nodisplay', '-nosplash', '-r', 'version, exit'], {
          timeout: 30000,
          windowsHide: true,
        }, (err2, stdout2, stderr2) => {
          if (err2) {
            reject(new Error(stderr2 || err2.message));
          } else {
            resolve(stdout2.trim());
          }
        });
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

/**
 * Run the test script via MATLAB.
 * @param {string} matlabExe
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number}>}
 */
function runTestScript(matlabExe) {
  return new Promise((resolve, reject) => {
    // Try -batch first (R2019b+)
    execFile(matlabExe, [
      '-batch',
      `run('${TEST_SCRIPT.replace(/\\/g, '/')}')`
    ], {
      timeout: 60000,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      if (err && err.code === 1 && stderr.includes('unrecognized option')) {
        // -batch not supported (older MATLAB), fallback to -nodisplay
        execFile(matlabExe, [
          '-nodisplay', '-nosplash',
          '-r', `run('${TEST_SCRIPT.replace(/\\/g, '/')}'), exit`
        ], {
          timeout: 60000,
          windowsHide: true,
        }, (err2, stdout2, stderr2) => {
          resolve({
            stdout: stdout2 || '',
            stderr: stderr2 || '',
            exitCode: err2 ? (err2.code || 1) : 0,
          });
        });
      } else {
        resolve({
          stdout: stdout || '',
          stderr: stderr || '',
          exitCode: err ? (err.code || 1) : 0,
        });
      }
    });
  });
}

async function main() {
  const result = {
    matlab_available: false,
    version: null,
    error: null,
  };

  const matlabExe = findMatlab();

  if (!matlabExe) {
    result.error = 'MATLAB executable not found. Checked well-known install paths and PATH.';
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }

  if (verbose) {
    console.error(`[check] Found MATLAB at: ${matlabExe}`);
  }

  // Get version
  try {
    const ver = await getMatlabVersion(matlabExe);
    result.version = ver.slice(0, 6).trim();  // e.g. "9.12.0" -> "9.12.0"
    if (verbose) console.error(`[check] MATLAB version: ${ver}`);
  } catch (err) {
    result.error = `Could not determine MATLAB version: ${err.message}`;
    if (verbose) console.error(`[check] Version check failed: ${err.message}`);
  }

  // Run test script
  try {
    const testResult = await runTestScript(matlabExe);
    if (testResult.exitCode === 0 && testResult.stdout.includes('MATLAB MCP OK')) {
      result.matlab_available = true;
    } else {
      result.matlab_available = false;
      let errMsg = `Test script failed with exit code ${testResult.exitCode}`;
      if (testResult.stderr) errMsg += `: ${testResult.stderr.trim()}`;
      if (!testResult.stdout.includes('MATLAB MCP OK') && testResult.stdout) {
        errMsg += ` (stdout did not contain expected marker)`;
      }
      result.error = errMsg;
    }
    if (verbose) {
      result._test_stdout = testResult.stdout;
      result._test_stderr = testResult.stderr;
    }
  } catch (err) {
    result.matlab_available = false;
    result.error = `Test script execution failed: ${err.message}`;
  }

  console.log(JSON.stringify(result, null, 2));

  if (!result.matlab_available) {
    if (verbose) console.error(`\n[check] MATLAB is NOT available. Creating fallback guidance...`);
    process.exit(0);
  }
}

main().catch(err => {
  console.log(JSON.stringify({
    matlab_available: false,
    version: null,
    error: `Unexpected error: ${err.message}`,
  }, null, 2));
  process.exit(0);
});
