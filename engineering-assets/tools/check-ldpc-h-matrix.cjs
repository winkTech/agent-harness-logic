#!/usr/bin/env node
'use strict';
/**
 * check-ldpc-h-matrix.cjs —— 把 RTL 的 P 矩阵 ROM 与参考模型的 cfg.P 逐元素比对
 *
 * 为什么需要单独一支:
 *   已有的 tools/gen-ldpc-conn-tables.cjs 是从 **RTL 自己的 r_p_rom** 展开连接表,
 *   所以 ROM 写错时它只会忠实地把错误展开一遍, 自检永远通过。
 *   实测就发生过: 块行 7/8/9/10 的双对角校验列整体少进了 1~2 列
 *   (块行 7 落在 j=18,19, 参考模型是 j=19,20)。连接**数**恰好不变, 因此
 *   conn_count 一类的检查全绿; 只有逐边比对参考模型才暴露, 表现为
 *   "多数比特对、少数错" —— 比全错更难定位。
 *
 *   反偏离锚链要求实现锚(CBB)对齐正确性锚(参考模型)。这支脚本就是那条边。
 *
 * 用法: node tools/check-ldpc-h-matrix.cjs
 * 退出码: 0 = 一致; 1 = 有差异; 2 = 解析失败
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const CONFIG_M = path.join(REPO, 'models', 'comm', 'ldpc', 'config.m');
const RTL_V = path.join(REPO, 'incubator', 'intake', 'ldpc_codec', 'rtl', 'h_matrix_addr.v');

function fail(msg) { console.error(`[check-h] ${msg}`); process.exit(2); }

// ── 参考模型: 解析 cfg.P 与 cfg.Z ──────────────────────────────────────────
let Z, P;
try {
  const src = fs.readFileSync(CONFIG_M, 'utf8');
  const zm = src.match(/cfg\.Z\s*=\s*(\d+)/);
  if (!zm) fail('config.m 找不到 cfg.Z');
  Z = Number(zm[1]);

  const start = src.indexOf('cfg.P = [');
  if (start < 0) fail('config.m 找不到 cfg.P');
  const open = src.indexOf('[', start);
  const close = src.indexOf('];', open);
  if (close < 0) fail('cfg.P 缺少结束的 "];"');

  P = src.slice(open + 1, close)
    .split(';')
    .map((r) => r.replace(/\.\.\./g, '').replace(/%[^\n]*/g, '').trim())
    .filter(Boolean)
    .map((r) => r.split(',').map((v) => Number(v.trim())));

  if (!P.length || P.some((r) => r.some((v) => !Number.isInteger(v)))) fail('cfg.P 解析出非整数');
} catch (e) {
  fail(`读取参考模型失败: ${e.message}`);
}

// ── RTL: 解析 r_p_rom (默认 31 = -1, 再被显式赋值覆盖) ─────────────────────
const code = fs.readFileSync(RTL_V, 'utf8');
const par = (n) => {
  const m = code.match(new RegExp(`parameter\\s+${n}\\s*=\\s*(\\d+)`));
  if (!m) fail(`RTL 找不到参数 ${n}`);
  return Number(m[1]);
};
const MB = par('P_MB');
const NB = par('P_NB');
const Z_RTL = par('P_Z');

if (Z_RTL !== Z) fail(`提升因子不一致: RTL P_Z=${Z_RTL}, 参考模型 cfg.Z=${Z}`);
if (P.length !== MB) fail(`基矩阵行数不一致: RTL P_MB=${MB}, 参考模型 ${P.length}`);
if (P[0].length !== NB) fail(`基矩阵列数不一致: RTL P_NB=${NB}, 参考模型 ${P[0].length}`);

const rom = new Array(MB * NB).fill(-1);
for (const m of code.matchAll(/r_p_rom\[\s*(\d+)\s*\]\s*=\s*\d+'d(\d+)\s*;/g)) {
  const idx = Number(m[1]);
  const val = Number(m[2]);
  if (idx >= rom.length) fail(`r_p_rom 下标越界: ${idx} >= ${rom.length}`);
  rom[idx] = val === 31 ? -1 : val;   // 5'd31 是 -1 的编码
}

// ── 逐元素比对 ─────────────────────────────────────────────────────────────
const diffs = [];
for (let b = 0; b < MB; b++) {
  for (let j = 0; j < NB; j++) {
    const want = P[b][j];
    const got = rom[b * NB + j];
    if (want !== got) diffs.push({ b, j, idx: b * NB + j, want, got });
  }
}

if (diffs.length) {
  console.error(`[check-h] ❌ RTL 的 P 矩阵与参考模型 cfg.P 有 ${diffs.length} 处不一致:`);
  for (const d of diffs.slice(0, 40)) {
    console.error(`  块行 ${d.b} 块列 ${d.j} (r_p_rom[${d.idx}]): RTL=${d.got}, 参考=${d.want}`);
  }
  if (diffs.length > 40) console.error(`  ... 其余 ${diffs.length - 40} 处略`);
  process.exit(1);
}

const nnz = P.flat().filter((v) => v >= 0).length;
console.log(`[check-h] ✅ P 矩阵与参考模型 cfg.P 完全一致 (${MB}x${NB}, ${nnz} 个非 -1 块, 展开 ${nnz * Z} 条边)`);
