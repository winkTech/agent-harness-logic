'use strict';

const fs = require('node:fs');

const { atomicWriteJson } = require('./project-scope.cjs');

function loadHistory(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!Array.isArray(parsed)) {
    throw new Error(`Evidence history must be an array: ${filePath}`);
  }
  return parsed;
}

function appendHistory(filePath, entry, opts = {}) {
  const maxEntries = opts.maxEntries ?? 50;
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new Error(`maxEntries must be a positive integer, got ${maxEntries}`);
  }

  if (opts.persist === false) return [entry];

  const history = loadHistory(filePath);
  history.push(entry);
  const retained = history.slice(-maxEntries);
  atomicWriteJson(filePath, retained);
  return retained;
}

module.exports = {
  appendHistory,
  loadHistory,
};
