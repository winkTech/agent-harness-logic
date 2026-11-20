'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

const profileName = 'matlab-mcp.json';
const setup = 'Install the MathWorks MATLAB MCP Server and put it on PATH, or set MATLAB_MCP_SERVER to its absolute executable path.';

function executable(file) {
  if (!file || !path.isAbsolute(file)) return false;
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch { return false; }
}

function findIn(dirs) {
  const suffix = { win32: 'win64.exe', darwin: 'macos-' + (process.arch === 'arm64' ? 'arm64' : 'x64'), linux: 'linux64' }[process.platform];
  const ext = process.platform === 'win32' ? '.exe' : '';
  const names = ['matlab-mcp-server', 'matlab-mcp-core-server'].flatMap(base => [base + ext, base + '-' + suffix]);
  for (const dir of dirs.filter(dir => path.isAbsolute(dir))) {
    for (const name of names) {
      const file = path.join(dir, name);
      if (executable(file)) return file;
    }
  }
  return null;
}

function findServer() {
  if (process.env.MATLAB_MCP_SERVER) {
    if (executable(process.env.MATLAB_MCP_SERVER)) return process.env.MATLAB_MCP_SERVER;
    throw new Error('Invalid MATLAB_MCP_SERVER. ' + setup);
  }
  const profile = path.join(os.homedir(), '.logical-paradox', profileName);
  if (fs.existsSync(profile)) {
    const saved = JSON.parse(fs.readFileSync(profile, 'utf8')).executable;
    if (executable(saved)) return saved;
  }
  return findIn([path.resolve(__dirname, '../../../packs/fpga/tools'), ...(process.env.PATH || '').split(path.delimiter)]);
}

// MATLAB is optional. A host without the external runtime can still load the plugin.
function serveUnavailable() {
  const lines = readline.createInterface({ input: process.stdin });
  lines.on('line', line => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg?.id == null) return;
    let reply;
    switch (msg.method) {
      case 'initialize':
        reply = { result: { protocolVersion: '2025-03-26', capabilities: { tools: {} },
          serverInfo: { name: 'harness-matlab-unavailable', version: '1' }, instructions: setup } };
        break;
      case 'tools/list': reply = { result: { tools: [] } }; break;
      case 'ping': reply = { result: {} }; break;
      default: reply = { error: { code: -32601, message: setup } };
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...reply }) + '\n');
  });
}

if (require.main === module) {
  try {
    const file = findServer();
    if (!file) serveUnavailable();
    else {
      const child = spawn(file, ['--matlab-display-mode=nodesktop', '--matlab-session-mode=new', '--disable-telemetry=true'],
        { stdio: 'inherit', windowsHide: true });
      child.on('error', error => { console.error(error.message); process.exitCode = 1; });
      child.on('exit', code => { process.exitCode = code ?? 1; });
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { findIn, profileName };
