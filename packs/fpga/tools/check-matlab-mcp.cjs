#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const { randomInt } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

async function check(manifest) {
  const server = JSON.parse(fs.readFileSync(manifest, 'utf8')).mcpServers.matlab;
  if (!server) throw new Error('Missing matlab in ' + manifest);
  const cwd = path.resolve(path.dirname(manifest), server.cwd || '.');
  const child = spawn(server.command, server.args, { cwd, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  let seq = 0;
  const fail = error => { for (const waiter of pending.values()) waiter.reject(error); pending.clear(); };
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.on('close', code => fail(new Error('MATLAB MCP closed before replying (exit ' + code + ')')));
  lines.on('line', line => {
    try {
      const msg = JSON.parse(line);
      const waiter = pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error.message));
      else waiter.resolve(msg.result);
    } catch (error) { fail(error); }
  });
  const send = msg => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
  const timeout = setTimeout(() => fail(new Error('MATLAB MCP timed out')), 120000);
  try {
    const init = await request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'harness-check', version: '1' } });
    send({ method: 'notifications/initialized' });
    const list = await request('tools/list', {});
    if (!list.tools.some(t => t.name === 'evaluate_matlab_code')) throw new Error(init.instructions || 'MATLAB evaluation tool unavailable');
    const a = randomInt(2, 100), b = randomInt(2, 100);
    const result = await request('tools/call', { name: 'evaluate_matlab_code', arguments: {
      project_path: os.tmpdir(), code: "fprintf('HARNESS_MATLAB=%d;RELEASE=%s\\n'," + a + "*" + b + ",version('-release'))",
    } });
    const output = (result.content || []).map(item => item.text || '').join('\n');
    const match = /^HARNESS_MATLAB=(\d+);RELEASE=(\w+)\s*$/m.exec(output);
    if (result.isError || !match || Number(match[1]) !== a * b) throw new Error('MATLAB result mismatch: ' + output.slice(0, 500));
    return { matlab_available: true, version: match[2], server: init.serverInfo.name, tools: list.tools.map(t => t.name), calculation: a + '*' + b + '=' + match[1], error: null };
  } finally {
    clearTimeout(timeout);
    child.stdin.end();
    const stop = setTimeout(() => child.kill(), 15000);
    stop.unref();
    child.once('close', () => clearTimeout(stop));
  }
}

if (require.main === module) {
  const root = path.resolve(__dirname, '../../..');
  const manifest = process.argv.find(arg => arg.startsWith('--manifest='))?.slice(11) || path.join(root, '.mcp.json');
  check(manifest).then(result => console.log(JSON.stringify(result))).catch(error => {
    console.log(JSON.stringify({ matlab_available: false, version: null, error: error.message }));
    process.exitCode = 1;
  });
}
