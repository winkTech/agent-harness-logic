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

# TB 把证据写在运行目录 (xsim 的 -testplusarg 传不了含盘符的路径), 搬到门禁约定位置
EVID="$ROOT/var/gates/pg/ofdm_tx_top"
mkdir -p "$EVID/stability"
for s in regression boundary backpressure stress; do
    cp "stability-$s.json" "$EVID/stability/$s.json"
done
cp reset-sim.json "$EVID/reset-sim.json"

# ---- cosim: 与 golden 位真镜像的 0 容差比对 (G-B-03) ----
# 向量由 tb/gen_cosim_vectors.m 调用 golden 的 rtl_mirror_tx 组装 (需 MATLAB)
if command -v matlab >/dev/null 2>&1; then
    echo "=========== 生成 cosim 向量 (MATLAB) ==========="
    matlab -batch "addpath('$PKG/tb'); gen_cosim_vectors('$BUILD')"
else
    echo "[warn] 未找到 matlab, 沿用 $BUILD 下已有的 cosim 向量"
fi

echo "=========== XSIM COSIM (0 容差) ==========="
xvlog -sv --relax "$PKG/tb/tb_tx_cosim.sv"
xelab --relax -debug typical -s cosim_sim work.tb_tx_cosim
xsim cosim_sim -runall
cp alignment-report.json "$EVID/alignment-report.json"

echo "=========== 证据落地: $EVID ==========="
