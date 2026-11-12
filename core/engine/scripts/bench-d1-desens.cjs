#!/usr/bin/env node
'use strict';

/**
 * core/engine/scripts/bench-d1-desens.cjs — D-1 脱敏扫描（Phase 4.2）
 *
 * `git ls-files` 管道扫描，命中面：
 *   - 文件名含 lihan（大小写不敏感）
 *   - 内容含 lihan.local / C:/Users/Lihan / C:\Users\Lihan / D:/lih
 * 豁免：
 *   - 模板占位符 __OWNER__ / __REPO_URL__ 本身
 *   - .gitattributes/.gitignore（治理文件引用）
 *   - 本扫描器自身与 bench-d2（守卫面自指）
 *   - docs/ 脱敏决策记录（标注依据）
 * 期望 = 0 命中。
 */

const { execSync } = require('node:child_process');
const fs = require('node:fs');

const EXEMPT = new Set([
  '.gitignore',
  '.gitattributes',
  'core/engine/scripts/bench-d1-desens.cjs',
  'core/engine/scripts/bench-d2-plugin-validate.cjs',
  'core/engine/scripts/test-hooks/desens-baseline.test.cjs',
]);

const CONTENT_PATTERNS = [
  /lihan\.local/i,
  /Users[\\\/]Lihan/i,
  /D:[\\\/]lih\b/i,
];

function main() {
  const files = execSync('git ls-files', { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  const hits = [];
  for (const file of files) {
    if (EXEMPT.has(file)) continue;
    if (/lihan/i.test(file)) { hits.push(`${file} (文件名)`); continue; }
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const re of CONTENT_PATTERNS) {
      if (re.test(text)) { hits.push(`${file} (${re.source})`); break; }
    }
  }
  if (hits.length > 0) {
    process.stderr.write(`[d1] ✖ ${hits.length} 处命中:\n${hits.slice(0, 20).map((h) => `  ${h}`).join('\n')}${hits.length > 20 ? '\n  ...' : ''}\n`);
    process.exit(1);
  }
  process.stdout.write('[d1] PASS 零命中（tracked 树无个人信息）\n');
}

main();
