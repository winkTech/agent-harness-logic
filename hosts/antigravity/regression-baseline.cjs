'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Only the offline regression runner writes baselines. The manifest is published last.
function save(directory, policy, passedIDs) {
  const tests = [...passedIDs].sort();
  if (!Buffer.isBuffer(policy) || !policy.length || !tests.length ||
      tests.some(id => typeof id !== 'string' || !id.trim()) || new Set(tests).size !== tests.length) {
    throw new Error('A baseline requires policy bytes and unique passing test IDs.');
  }
  const target = path.resolve(directory);
  const sha256 = crypto.createHash('sha256').update(policy).digest('hex');
  const manifest = {
    version: 1,
    sha256,
    tests,
    node: process.version,
    platform: process.platform,
    architecture: process.arch
  };
  // Reserving the directory prevents two successful runs from replacing each other's evidence.
  fs.mkdirSync(target);
  try {
    fs.writeFileSync(path.join(target, 'tool-policy.cjs'), policy, {flag: 'wx'});
    fs.writeFileSync(path.join(target, 'manifest.tmp'), JSON.stringify(manifest, null, 2) + '\n', {flag: 'wx'});
    fs.renameSync(path.join(target, 'manifest.tmp'), path.join(target, 'manifest.json'));
  } catch (error) {
    // Only our newly created directory and our two private files may be removed.
    for (const file of ['manifest.tmp', 'tool-policy.cjs']) {
      try { fs.unlinkSync(path.join(target, file)); } catch {}
    }
    try { fs.rmdirSync(target); } catch {}
    throw error;
  }
  return manifest;
}

module.exports = {save};
