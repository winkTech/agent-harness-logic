#!/usr/bin/env bash
# Vivado xsim 验证入口 — ofdm_tx_top (与 run.do 同一 TB, 同一判据)
#
# 用法 (任意目录):  bash <PKG>/run_xsim.sh
# 构建产物落在 $ROOT/var/build/ofdm_tx_top, 不污染资产包 (治理规范 §5.5)。
#
# 存在两条通路的原因: 0.2.0 的验证证据由 xsim 2023.1 产出 —— 当时本机
# ModelSim 10.6c 的 vish/vsim 回环 RPC 故障 (IPv6 ::1 可 bind 不可 connect),
# 任何设计都无法加载。两条通路互为交叉验证, 结论一致即可采信。
set -euo pipefail

PKG="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$PKG"
while [ "$(basename "$ROOT")" != "engineering-assets" ] && [ "$ROOT" != "/" ]; do
    ROOT="$(dirname "$ROOT")"
done
BUILD="$ROOT/var/build/ofdm_tx_top"

mkdir -p "$BUILD"
cd "$BUILD"

echo "=========== XVLOG ANALYZE ==========="
xvlog -sv --relax \
    "$PKG/rtl/tx_mapper.sv" \
    "$PKG/rtl/tx_pilot_map.sv" \
    "$PKG/rtl/ifft64_sdf.sv" \
    "$PKG/rtl/tx_cp_insert.sv" \
    "$PKG/rtl/ofdm_tx_top.sv" \
    "$PKG/tb/tb_tx_top.sv"

echo "=========== XELAB ==========="
xelab --relax -debug typical -s tb_sim work.tb_ofdm_tx_top

echo "=========== XSIM RUN ==========="
xsim tb_sim -runall
