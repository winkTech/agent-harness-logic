#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const server = require('../../mcp/codegraph-server.cjs');
const { openDb } = require('../../sqlite/index.cjs');

function callRpc(method, params, opts) {
  let captured = null;
  server.handleRequest(
    { jsonrpc: '2.0', id: 1, method, params: params || {} },
    (_id, result) => { captured = result; },
    opts,
  );
  return captured;
}

test('MCP App capabilities, resource HTML, and <= 64-char namespaced tool names', () => {
  const init = callRpc('initialize');
  assert.ok(init.capabilities.tools);
  assert.ok(init.capabilities.resources, 'MCP App servers must declare resources capability');

  const { tools } = callRpc('tools/list');
  const prefix = 'mcp_logical-paradox_codegraph_';
  for (const tool of tools) {
    assert.ok(
      (prefix + tool.name).length <= 64,
      `Tool name exceeds Antigravity 64-char limit: ${prefix + tool.name}`,
    );
  }

  const consoleTool = tools.find((t) => t.name === 'harness_console');
  assert.ok(consoleTool);
  assert.equal(consoleTool._meta.ui.resourceUri, 'ui://harness/console.html');
  assert.deepEqual(
    consoleTool._meta['com.google.antigravity/ui'].entrypoints.map((e) => e.type),
    ['aux_pane', 'global'],
  );

  for (const appOnlyName of ['harness_ui_refresh', 'harness_ui_signoff', 'harness_ui_reset_gate', 'harness_ui_maintain']) {
    const tool = tools.find((t) => t.name === appOnlyName);
    assert.ok(tool, `missing app-only tool ${appOnlyName}`);
    assert.deepEqual(tool._meta.ui.visibility, ['app'], `${appOnlyName} must stay hidden from the LLM`);
  }

  const { resources } = callRpc('resources/list');
  assert.equal(resources.length, 1);
  assert.equal(resources[0].uri, 'ui://harness/console.html');
  assert.equal(resources[0].mimeType, 'text/html;profile=mcp-app');

  const read = callRpc('resources/read', { uri: 'ui://harness/console.html' });
  assert.equal(read.contents.length, 1);
  assert.equal(read.contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.match(read.contents[0].text, /ui\/initialize/);
  assert.match(read.contents[0].text, /--color-background-primary/);
  assert.ok(Buffer.byteLength(read.contents[0].text, 'utf8') < 10 * 1024 * 1024);
});

test('MCP App console reads state and human-only signoff/reset mutate only isolated fixture gate', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-console-'));
  const prevState = process.env.HARNESS_STATE_DIR;
  process.env.HARNESS_STATE_DIR = tmp;
  t.after(() => {
    if (prevState === undefined) delete process.env.HARNESS_STATE_DIR;
    else process.env.HARNESS_STATE_DIR = prevState;
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const dbPath = path.join(tmp, 'test.db');
  const db = openDb({ path: dbPath });
  db.close();

  const gateFile = path.join(tmp, 'verify-gate.json');
  fs.writeFileSync(gateFile, JSON.stringify({
    version: 4,
    pending: { 'C:/demo::s1': { projectRoot: 'C:/demo', sessionId: 's1', editCount: 2 } },
    risk: { 'C:/demo::s1': { effectiveRiskLevel: 'R3', humanSignoff: true, riskReasons: ['protected'], verificationStatus: 'pending' } },
  }, null, 2));

  const auditPath = path.join(tmp, 'var', 'audit', 'mcp-app-actions.jsonl');
  const opts = { verifyGateFile: gateFile, dbPath, auditFile: auditPath, pluginDir: path.join(tmp, 'no-plugin') };
  const open = callRpc('tools/call', { name: 'harness_console', arguments: {} }, opts);
  assert.notEqual(open.structuredContent.health.status, 'error', open.structuredContent.health.error);
  assert.equal(open.structuredContent.gate.pendingCount, 1);
  assert.equal(open.structuredContent.gate.riskCount, 1);

  const signed = callRpc('tools/call', {
    name: 'harness_ui_signoff',
    arguments: { scopeKey: 'C:/demo::s1', reason: 'Reviewed in side pane' },
  }, opts);
  assert.equal(signed.structuredContent.ok, true);
  assert.equal(signed.structuredContent.snapshot.gate.riskCount, 0);
  assert.equal(signed.structuredContent.snapshot.gate.pendingCount, 0);

  const savedGate = JSON.parse(fs.readFileSync(gateFile, 'utf8'));
  assert.equal(savedGate.signoffs.length, 1);
  assert.equal(savedGate.signoffs[0].signedBy, 'mcp-app-human');

  // Verify audit log written without leaking any secrets.
  assert.ok(fs.existsSync(auditPath));
  assert.match(fs.readFileSync(auditPath, 'utf8'), /"action":"human-signoff"/);
});
