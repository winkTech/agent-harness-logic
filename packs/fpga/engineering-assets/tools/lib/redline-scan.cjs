#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function stripAnsi(text) {
  return String(text).replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, '');
}

function stripComments(text) {
  return stripAnsi(text).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function lineOf(text, index) { return text.slice(0, index).split(/\r?\n/).length; }

function rtlSources(pkgDir, manifest) {
  return (manifest.sources || []).filter((source) => source.role === 'rtl').map((source) => ({
    path: source.path,
    abs: path.join(pkgDir, source.path),
  })).filter((source) => fs.existsSync(source.abs));
}

function scanSource(source, manifest) {
  const raw = fs.readFileSync(source.abs, 'utf8');
  const text = stripComments(raw);
  const flags = [];
  const outputs = new Set();
  const outputDecl = /\boutput\b(?:\s+(?:logic|reg|wire|signed|unsigned))*\s*(?:\[[^\]]+\]\s*)*([A-Za-z_]\w*)/g;
  let declaration;
  while ((declaration = outputDecl.exec(text))) outputs.add(declaration[1]);
  const tready = [...outputs].filter((name) => /tready$/i.test(name));
  const seen = new Set();
  const add = (category, flag_id, signal, index, detail) => {
    const line = lineOf(text, index);
    const key = `${category}|${signal}|${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    flags.push({ category, flag_id, signal, file: source.path, line, detail });
  };
  for (const signal of outputs) {
    const directRe = new RegExp(`\\bassign\\s+${signal}\\b\\s*=\\s*([^;]+)`, 'g');
    let direct;
    while ((direct = directRe.exec(text))) {
      const rhs = direct[1];
      const category = /tready$/i.test(signal) ? 'COMB' : /\b(?:r_|ro_)[A-Za-z0-9_]*/.test(rhs) ? 'REG' : 'COMB';
      add(category, category === 'REG' ? 'RL-OUT-REG' : 'RL-OUT-COMB', signal, direct.index, category === 'REG' ? 'continuous assignment from registered state' : 'continuous output assignment');
    }
    const proceduralRe = new RegExp(`(?<!assign\\s)\\b${signal}\\b\\s*(?:\\[[^\\]]+\\])?\\s*(<=|=(?!=))`, 'g');
    let procedural;
    while ((procedural = proceduralRe.exec(text))) {
      const prefix = text.slice(Math.max(0, procedural.index - 12), procedural.index);
      if (/assign\\s*$/.test(prefix)) continue;
      const category = procedural[1] === '<=' ? 'REG' : 'COMB';
      add(category, category === 'REG' ? 'RL-OUT-REG' : 'RL-OUT-COMB', signal, procedural.index, category === 'REG' ? 'clocked/procedural output assignment' : 'procedural combinational output');
    }
  }
  for (const signal of tready) if (!flags.some((flag) => flag.signal === signal)) add('UNKNOWN', 'RL-OUT-UNKNOWN', signal, 0, 'tready declaration has no direct assignment evidence');
  const params = [];
  const parameterRe = /\bparameter(?:\s+(?:integer|int|logic|bit|signed|unsigned))?\s+([A-Za-z_]\w*)\s*=\s*([^,;\)]+)/g;
  let parameter;
  while ((parameter = parameterRe.exec(text))) params.push({ name: parameter[1], default: parameter[2].trim(), file: source.path, line: lineOf(text, parameter.index) });
  return { path: source.path, flags, parameters: params, outputs: [...outputs], tready };
}

function scanAsset(pkgDir, manifest, adrRef = 'docs/governance/adr/ADR-001-axis-tready-and-output-registration.md') {
  const sources = rtlSources(pkgDir, manifest).map((source) => scanSource(source, manifest));
  const flags = sources.flatMap((source) => source.flags);
  const parameters = sources.flatMap((source) => source.parameters);
  const tready = [...new Set(sources.flatMap((source) => source.tready))].map((signal) => ({
    signal,
    category: flags.find((flag) => flag.signal === signal)?.category || 'UNKNOWN',
    basis: 'ADR-001 axis-tready-and-output-registration; tready registration is governed by the accepted skid-buffer axis decision',
    adr_ref: adrRef,
  }));
  return {
    scanner_version: '2.0',
    asset_uid: manifest.asset_uid,
    manifest_version: manifest.version,
    files: sources.map((source) => source.path),
    categories: { REG: flags.filter((flag) => flag.category === 'REG').length, COMB: flags.filter((flag) => flag.category === 'COMB').length, PARAM: parameters.length, UNKNOWN: flags.filter((flag) => flag.category === 'UNKNOWN').length },
    flags,
    parameters,
    tready,
  };
}

module.exports = { scanAsset, scanSource, stripAnsi, stripComments };
