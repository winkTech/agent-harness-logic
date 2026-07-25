'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { HARNESS_ROOT } = require('./harness-root.cjs');

const SCHEMA_DIR = path.join(HARNESS_ROOT, 'engine', 'schemas');
const CATALOG_FILE = path.join(SCHEMA_DIR, 'catalog.json');

function schemaFiles(schemaDir = SCHEMA_DIR) {
  return fs.readdirSync(schemaDir)
    .filter((name) => name.endsWith('.schema.json'))
    .sort();
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function validateSchemaCatalog(options = {}) {
  const schemaDir = options.schemaDir || SCHEMA_DIR;
  const catalogFile = options.catalogFile || path.join(schemaDir, 'catalog.json');
  const errors = [];
  let catalog;

  try {
    catalog = readJson(catalogFile);
  } catch (error) {
    return { catalog: null, errors: [`catalog is not valid JSON: ${error.message}`], files: [] };
  }

  const entries = Array.isArray(catalog.entries) ? catalog.entries : [];
  if (!Array.isArray(catalog.entries)) errors.push('catalog.entries must be an array');
  if (catalog.schemaCount !== entries.length) {
    errors.push(`catalog.schemaCount=${catalog.schemaCount} does not match entries=${entries.length}`);
  }

  const files = schemaFiles(schemaDir);
  const catalogFiles = entries.map((entry) => entry && entry.file).filter(Boolean).sort();
  const duplicateFiles = catalogFiles.filter((file, index) => catalogFiles.indexOf(file) !== index);
  if (duplicateFiles.length > 0) errors.push(`duplicate catalog entries: ${[...new Set(duplicateFiles)].join(', ')}`);

  const missing = files.filter((file) => !catalogFiles.includes(file));
  const stale = catalogFiles.filter((file) => !files.includes(file));
  if (missing.length > 0) errors.push(`schemas missing from catalog: ${missing.join(', ')}`);
  if (stale.length > 0) errors.push(`catalog entries without schema files: ${stale.join(', ')}`);

  const ids = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry.file !== 'string') {
      errors.push('every catalog entry must have a file');
      continue;
    }
    const filePath = path.join(schemaDir, entry.file);
    if (!fs.existsSync(filePath)) continue;
    try {
      const schema = readJson(filePath);
      if (typeof schema.$schema !== 'string' || schema.$schema.length === 0) {
        errors.push(`${entry.file} is missing $schema`);
      }
      if ((schema.title || null) !== (entry.title || null)) {
        errors.push(`${entry.file} title differs from catalog`);
      }
      if ((schema.$id || null) !== (entry.id || null)) {
        errors.push(`${entry.file} id differs from catalog`);
      }
      if (schema.$id) {
        if (ids.has(schema.$id)) errors.push(`duplicate schema id: ${schema.$id}`);
        ids.set(schema.$id, entry.file);
      }
    } catch (error) {
      errors.push(`${entry.file} is not valid JSON: ${error.message}`);
    }
  }

  return { catalog, errors, files };
}

module.exports = {
  CATALOG_FILE,
  SCHEMA_DIR,
  readJson,
  schemaFiles,
  validateSchemaCatalog,
};
