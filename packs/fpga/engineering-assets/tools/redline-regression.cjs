#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { scanRepository } = require('./catalog-gen.cjs');
const { scanAsset, stripAnsi } = require('./lib/redline-scan.cjs');

const ASSETS = ['rrc_polyphase_fir', 'ldpc_codec', 'channel_est_top', 'ofdm_tx_top', 'sync_top'];
// 2026-08-08 重新基线。旧基线点名的多数文件**已经不存在**了 —— 四件资产在走向
// certified 的改造里重命名并合并了子模块 (mapper.sv→tx_mapper.sv, cp_insert.sv→
// tx_cp_insert.sv, pilot_insert.sv→tx_pilot_map.sv, xfft_64.sv→ifft64_sdf.sv,
// ldpc_decoder_top.v 的 llr 通路移入 ldpc_stream_io.v)，基线没跟着走，于是本条从那时起
// 必挂。它一直没被发现，是因为 test-catalog-audit 更早的 ENOENT 硬崩把整个套件掀了。
//
// 重新基线**不是把红灯改绿**，依据是权威门梯而非本表: 五件的 RL-OUT 门今天实跑全部
// ✅「输出均由寄存/常量驱动」，且四件 rtl 资产 gate-runner 判定仍是 CERTIFIED。
// 本表的作用是钉住"观察到的集合"，让下次无声变化能冒出来，不是断言集合为空 ——
// 残留的 <top>.sv|s_axis_tready 属 ADR-001 允许的组合 tready 直通，门梯已认。
const EXPECTED_REDLIST = {
  channel_est_top: ['rtl/channel_est_top.sv|s_axis_tready'],
  ldpc_codec: ['rtl/ldpc_encoder_top.v|s_axis_info_tready', 'rtl/ldpc_stream_io.v|s_axis_llr_tready'],
  ofdm_tx_top: ['rtl/ofdm_tx_top.sv|s_axis_tready'],
  rrc_polyphase_fir: ['rtl/rrc_polyphase_fir.sv|s_axis_tready'],
  sync_top: ['rtl/sync_top.sv|s_axis_tready'],
};

function expectedFor(uid) { return [...EXPECTED_REDLIST[uid]].sort(); }

function build(root) {
  const scan = scanRepository(root);
  const assets = [];
  const errors = [];
  if (stripAnsi('\u001b[31mprobe\u001b[0m') !== 'probe') errors.push('ANSI escape parsing failed');
  for (const uid of ASSETS) {
    const asset = scan.assets.find((item) => item.asset_uid === uid);
    if (!asset) { errors.push(`missing asset ${uid}`); continue; }
    const result = scanAsset(path.join(root, asset.dir), asset.manifest);
    const observed = [...new Set(result.flags.filter((flag) => flag.category === 'COMB' && /tready|m_axis|s_axis/i.test(flag.signal)).map((flag) => `${flag.file}|${flag.signal}`))].sort();
    const expected = expectedFor(uid);
    const pass = JSON.stringify(observed) === JSON.stringify(expected);
    if (!pass) errors.push(`${uid} redlist drift expected=${expected.join(',')} observed=${observed.join(',')}`);
    assets.push({
      asset_uid: uid,
      manifest_version: result.manifest_version,
      categories: result.categories,
      files: result.files,
      expected_redlist: expected,
      observed_redlist: observed,
      tready: result.tready,
      pass,
    });
  }
  return { schema_version: '2.0', generated_by: 'redline-regression.cjs', scanner: 'tools/lib/redline-scan.cjs@2.0', adr_basis: 'docs/governance/adr/ADR-001-axis-tready-and-output-registration.md', assets, errors, pass: errors.length === 0 && assets.length === ASSETS.length };
}

function main(argv = process.argv.slice(2)) {
  const rootIndex = argv.indexOf('--root');
  const root = path.resolve(rootIndex >= 0 ? argv[rootIndex + 1] : path.resolve(__dirname, '..'));
  const output = path.join(root, 'var', 'audit', 'rlout-v2-regression.json');
  const result = build(root);
  if (argv.includes('--write')) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.log(`[redline-regression] wrote ${path.relative(root, output)} pass=${result.pass}`);
  }
  if (argv.includes('--check')) {
    if (!fs.existsSync(output)) { console.error(`[redline-regression] missing ${path.relative(root, output)}; run --write first`); return 1; }
    const actual = JSON.parse(fs.readFileSync(output, 'utf8'));
    if (JSON.stringify(actual) !== JSON.stringify(result)) { console.error('[redline-regression] stale or drifted regression result'); return 1; }
  }
  if (!argv.includes('--write') && !argv.includes('--check')) console.log(JSON.stringify(result, null, 2));
  if (!result.pass) result.errors.forEach((error) => console.error(`[redline-regression] ${error}`));
  return result.pass ? 0 : 1;
}

if (require.main === module) process.exitCode = main();
module.exports = { ASSETS, EXPECTED_REDLIST, build, main };
