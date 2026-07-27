#!/usr/bin/env node
'use strict';
/**
 * gen-ldpc-conn-tables.cjs — 由 h_matrix_addr.v 中的 P 矩阵常量展开连接索引表
 *
 * 背景: 原实现在 initial 块里用 `if (r_p_rom[...] != 5'd31)` 扫描构建
 *   r_conn_col / r_conn_shft / r_conn_cnt。条件依赖 reg 数组内容, Vivado 判定
 *   为非常量条件, 报 [Synth 8-6896] 并**丢弃整个 initial 块** —— 仿真里表有值,
 *   综合后这三张表没有驱动源 ([Synth 8-3848]), 上板行为与仿真不一致。
 *
 * 本脚本把该展开搬到编译前: 从 RTL 源码解析 r_p_rom 的常量赋值, 用与原
 * initial 完全相同的算法展开, 生成纯常量赋值的 Verilog 块 —— 与 r_p_rom
 * 自身的写法一致 (该写法已被同一综合器正确推断)。
 *
 * 常量取自 RTL 源码本身而非手工转写, 保证与当前 P 矩阵同源。
 *
 * 用法: node tools/gen-ldpc-conn-tables.cjs <h_matrix_addr.v> [--emit]
 *   不带 --emit 只做解析与自检; 带 --emit 打印可粘贴的 initial 块。
 */

const fs = require('node:fs');

const src = process.argv[2];
if (!src) { console.error('用法: node gen-ldpc-conn-tables.cjs <h_matrix_addr.v> [--emit]'); process.exit(2); }
const code = fs.readFileSync(src, 'utf8');

// ── 参数 ────────────────────────────────────────────────────────────────
const param = (name) => {
  const m = code.match(new RegExp(`parameter\\s+${name}\\s*=\\s*(\\d+)`));
  if (!m) { console.error(`[gen] 找不到参数 ${name}`); process.exit(2); }
  return Number(m[1]);
};
const P_MB = param('P_MB');
const P_NB = param('P_NB');
const P_MAX_ROW_WT = param('P_MAX_ROW_WT');
const P_SHIFT_W = param('P_SHIFT_W');
const P_CONN_CNT_W = param('P_CONN_CNT_W');
const DEPTH = P_MB * P_NB;

// ── 解析 r_p_rom 常量赋值 ───────────────────────────────────────────────
// 默认值来自 `for (...) r_p_rom[init_i] = 5'd31;`, 再被显式赋值覆盖。
const rom = new Array(DEPTH).fill(31);
let assigned = 0;
for (const m of code.matchAll(/r_p_rom\[\s*(\d+)\s*\]\s*=\s*(\d+)'d(\d+)\s*;/g)) {
  const idx = Number(m[1]);
  const val = Number(m[3]);
  if (idx >= DEPTH) { console.error(`[gen] r_p_rom 下标越界: ${idx} >= ${DEPTH}`); process.exit(2); }
  rom[idx] = val;
  assigned++;
}
if (!assigned) { console.error('[gen] 未解析到任何 r_p_rom 常量赋值 —— 拒绝在空矩阵上生成'); process.exit(2); }

// ── 按原 initial 的算法展开 ─────────────────────────────────────────────
const connCol = [];
const connShft = [];
const connCnt = [];
for (let br = 0; br < P_MB; br++) {
  const cols = []; const shfts = [];
  for (let bc = 0; bc < P_NB; bc++) {
    const v = rom[br * P_NB + bc];
    if (v !== 31) { cols.push(bc); shfts.push(v); }
  }
  if (cols.length > P_MAX_ROW_WT) {
    console.error(`[gen] block row ${br} 连接数 ${cols.length} 超过 P_MAX_ROW_WT=${P_MAX_ROW_WT}`);
    process.exit(2);
  }
  connCol.push(cols); connShft.push(shfts); connCnt.push(cols.length);
}

// ── 自检: 生成结果必须与"逐元素重跑原算法"一致 ──────────────────────────
// 防止上面的展开与原 initial 语义漂移。
let selfcheckFail = 0;
for (let br = 0; br < P_MB; br++) {
  let ci = 0;
  for (let bc = 0; bc < P_NB; bc++) {
    if (rom[br * P_NB + bc] !== 31) {
      if (connCol[br][ci] !== bc || connShft[br][ci] !== rom[br * P_NB + bc]) selfcheckFail++;
      ci++;
    }
  }
  if (connCnt[br] !== ci) selfcheckFail++;
}
if (selfcheckFail) { console.error(`[gen] 自检失败: ${selfcheckFail} 处与原算法不一致, 拒绝输出`); process.exit(1); }

// msg_buffer 块基址: base[b] = sum_{b'<b} Z * cnt[b']
// msg_buffer.v 契约为 "地址 = row_base[row] + conn_idx", 其中
// row_base[r] = base[blockrow(r)] + blockoff(r) * cnt[blockrow(r)]。
const P_Z = param('P_Z');
const blkBase = [];
let acc = 0;
for (let br = 0; br < P_MB; br++) { blkBase.push(acc); acc += P_Z * connCnt[br]; }
const P_H_NNZ = acc;

console.error(`[gen] P 矩阵: ${assigned} 条非默认项 / ${DEPTH} 槽`);
console.error(`[gen] 块基址: ${blkBase.join(', ')}  总边数 ${P_H_NNZ}`);
console.error(`[gen] 每 block row 连接数: ${connCnt.join(', ')}  (max=${Math.max(...connCnt)}, 上限 ${P_MAX_ROW_WT})`);
console.error('[gen] 自检通过: 生成结果与原 initial 算法逐条一致');

if (!process.argv.includes('--emit')) process.exit(0);

// ── 生成 Verilog ────────────────────────────────────────────────────────
const out = [];
out.push('    integer br, ci;');
out.push('    initial begin');
out.push('        // 未用槽位清零 (常量边界循环, 可综合)');
out.push('        for (br = 0; br < P_MB; br = br + 1) begin');
out.push(`            r_conn_cnt[br] = {P_CONN_CNT_W{1'b0}};`);
out.push('            for (ci = 0; ci < P_MAX_ROW_WT; ci = ci + 1) begin');
out.push(`                r_conn_col [br][ci] = 6'd0;`);
out.push(`                r_conn_shft[br][ci] = {P_SHIFT_W{1'b0}};`);
out.push('            end');
out.push('        end');
out.push('');
out.push('        // ==== 以下由 tools/gen-ldpc-conn-tables.cjs 从本文件 r_p_rom 展开生成 ====');
out.push('        // ==== 请勿手改; P 矩阵变更后重跑该脚本重新生成                    ====');
// 每行放 2 组 (col, shft), 与上方 r_p_rom 的紧凑表格风格一致;
// 逐组一行会把本文件顶过 G-A-04 的 300 行上限, 而这些是数据不是逻辑。
for (let br = 0; br < P_MB; br++) {
  out.push(`        r_conn_cnt[${br}] = ${P_CONN_CNT_W}'d${connCnt[br]};`);
  const cells = [];
  for (let ci = 0; ci < connCnt[br]; ci++) {
    cells.push(`r_conn_col[${br}][${ci}]=6'd${connCol[br][ci]};`.padEnd(24)
      + `r_conn_shft[${br}][${ci}]=${P_SHIFT_W}'d${connShft[br][ci]};`.padEnd(26));
  }
  for (let i = 0; i < cells.length; i += 2) out.push(`        ${cells.slice(i, i + 2).join('').trimEnd()}`);
}
out.push('');
out.push('        // ---- msg_buffer 块基址 (同源生成): base[b] = sum_{b\'<b} Z*cnt[b\'] ----');
for (let br = 0; br < P_MB; br += 4) {
  const cells = [];
  for (let i = br; i < Math.min(br + 4, P_MB); i++) {
    cells.push(`r_blk_base[${i}]=${blkBase[i] === 0 ? "12'd0" : `12'd${blkBase[i]}`};`.padEnd(22));
  }
  out.push(`        ${cells.join('').trimEnd()}`);
}
out.push('    end');
out.push('');
out.push(`    // 校验: 总边数 = ${P_H_NNZ}, 应等于 msg_buffer 的 P_H_NNZ 深度`);
console.log(out.join('\n'));
