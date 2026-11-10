#!/usr/bin/env node
/**
 * regen-vectors.cjs — 忠实复算 rrc_pulse_shaping.m 定点语义, 仲裁并再生期望向量
 *
 * 背景: vectors/expected_tx.hex 原始导出损坏(2048 行全为 00008001 = -max_q 裁剪轨)。
 * 本脚本按 golden 代码(权威)的确切语义重算:
 *   h_quant = rrc_coeff.hex (Q1.15, 33 taps)  [rrc_coeff_gen.m L51: round(h*2^15)/2^15]
 *   x_up    = upsample(x, 4)                  [rrc_pulse_shaping.m L20]
 *   y_f     = conv(x_up, h_quant, 'full')     [L24]
 *   y_trim  = y_f(delay+1 : delay+len), delay=(33-1)/2=16  [L27-28]
 *   y_quant = clip(round(y_trim * 2^14)/2^14, ±32767/2^14) [L41-42]
 *   导出    = int16(round(y_quant*2^14)) 打包 {Q,I}        [generate_vectors.m]
 * 整数等价式: y_int[m] = clip(round_half_away(acc[m] / 2^15), ±32767),
 *   acc[m] = Σ_j h_int[j] * x_int_up[m+16-j]  (x=Q2.14 int, h=Q1.15 int)
 * 输出: vectors/expected_tx.regen.bin (与原格式一致 %08x\n)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const here = __dirname;
const root = path.join(here, '..');

const s16 = (u) => (u & 0x8000) ? u - 0x10000 : u;

// 读 33 抽头系数 (Q1.15 int)
const h = fs.readFileSync(path.join(root, 'rrc_coeff.hex'), 'utf8')
  .trim().split(/\r?\n/).map((l) => s16(parseInt(l.trim(), 16)));
if (h.length !== 33) throw new Error(`系数应 33 行, 实为 ${h.length}`);
// 对称性检查 h[j] == h[32-j]
for (let j = 0; j <= 16; j++) if (h[j] !== h[32 - j]) throw new Error(`系数不对称 @${j}`);

// 读激励 (Q2.14 int, {Q,I} 打包)
const stimLines = fs.readFileSync(path.join(root, 'vectors', 'rrc_stimulus.hex'), 'utf8').trim().split(/\r?\n/);
const xi = [], xq = [];
for (const l of stimLines) {
  const w = parseInt(l.trim(), 16) >>> 0;
  xi.push(s16(w & 0xffff));
  xq.push(s16((w >>> 16) & 0xffff));
}
const NSYM = xi.length, SPS = 4, DELAY = 16, NOUT = NSYM * SPS;
console.log(`载入: ${NSYM} 符号, ${h.length} 抽头; 输出 ${NOUT} 样点`);

// round-half-away-from-zero(acc / 2^15), MATLAB round 语义
function rha15(acc) {
  const a = acc < 0n ? -acc : acc;
  const q = (a + 16384n) >> 15n;
  const r = acc < 0n ? -q : q;
  return r > 32767n ? 32767 : r < -32767n ? -32767 : Number(r); // clip ±32767 (golden L42: ±max_q)
}

// y_int[m] = Σ_j h[j]*x_up[m+16-j]; x_up[4n]=x[n], 其余 0
function filterCh(x) {
  const y = new Array(NOUT);
  for (let m = 0; m < NOUT; m++) {
    let acc = 0n;
    const base = m + DELAY;                    // conv 'full' 裁剪后的绝对索引
    for (let j = 0; j < 33; j++) {
      const u = base - j;                      // x_up 索引
      if (u < 0 || (u & 3) !== 0) continue;    // 非 4 的倍数 = 上采样零
      const n = u >> 2;
      if (n >= NSYM) continue;
      acc += BigInt(h[j]) * BigInt(x[n]);
    }
    y[m] = rha15(acc);
  }
  return y;
}

const yi = filterCh(xi), yq = filterCh(xq);

// 打包导出 (同 generate_vectors.m: %08x of {Q[15:0],I[15:0]})
const out = [];
for (let m = 0; m < NOUT; m++) {
  const w = (((yq[m] & 0xffff) << 16) | (yi[m] & 0xffff)) >>> 0;
  out.push(w.toString(16).padStart(8, '0'));
}
fs.writeFileSync(path.join(root, 'vectors', 'expected_tx.regen.hex'), out.join('\n') + '\n');

// 统计 + 抽样
const uniq = new Set(out);
console.log(`再生完成: expected_tx.regen.bin, ${out.length} 行, 唯一值 ${uniq.size} 个`);
console.log(`首 4 样点: ${out.slice(0, 4).join(' ')}`);
console.log(`理论 y[0].I = round(h16*x0/2^15) = ${rha15(BigInt(h[16]) * BigInt(xi[0]))} (0x${(rha15(BigInt(h[16]) * BigInt(xi[0])) & 0xffff).toString(16)})`);
const maxAbs = Math.max(...yi.map(Math.abs), ...yq.map(Math.abs));
console.log(`最大幅值: ${maxAbs} (${(maxAbs / 16384).toFixed(4)} Q2.14) — 若 >32760 说明确有裁剪风险`);
