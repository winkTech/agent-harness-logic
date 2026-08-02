#!/usr/bin/env bash
# Vivado xsim 验证入口 — sync_top (与 tb/run_sim.do + tb/run_cosim.do 同一组 TB、
# 同一套判据, 两条通路互为交叉验证)
#
# 用法 (任意目录):  bash <PKG>/run_xsim.sh [--install]
#
# 为什么需要它: 本机 ModelSim 回环 RPC 自 2026-08-01 起故障, .do 那条路跑不通,
# 本资产的 certified 证据无法复现。
#
# 路径注入: xsim 的 -testplusarg 在 Windows 上传不了含盘符的路径, 故不传
# +VEC_DIR/+EVID_DIR —— 先把向量拷进构建目录, TB 按运行目录相对读写, 跑完再搬。
set -euo pipefail

PKG="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$PKG"
while [ "$(basename "$ROOT")" != "engineering-assets" ] && [ "$ROOT" != "/" ]; do
    ROOT="$(dirname "$ROOT")"
done
BUILD="$ROOT/var/build/sync_top"
VEC="$ROOT/models/comm/synch/vectors"
EVID="$ROOT/var/gates/pg/sync_top"
INSTALL="${1:-}"

rm -rf "$BUILD"
mkdir -p "$BUILD/stability"
cd "$BUILD"

# 向量权威位置仍是 models/comm/synch/vectors/; 这里只是拷进运行目录供 TB 相对读取
cp "$VEC/sync_stimulus.bin" "$VEC/expected_sync_out.bin" \
   "$VEC/t1_sign_coeffs.txt" "$VEC/vector_config.txt" .

# 工具名经文件注入 (xsim 的 -testplusarg 会在 `=` 处把参数切碎)
echo "Vivado-xsim-2023.1.1" > sim-tool.txt

RTL=(
    "$PKG/rtl/cordic_cv.sv"
    "$PKG/rtl/cordic_rot_pipe.sv"
    "$PKG/rtl/sync_correlator.sv"
    "$PKG/rtl/sync_detect.sv"
    "$PKG/rtl/sync_track_out.sv"
    "$PKG/rtl/sync_top.sv"
)

echo "=========== XVLOG ==========="
xvlog -sv --relax "${RTL[@]}" "$PKG/tb/tb_sync_top.sv" "$PKG/tb/tb_sync_cosim.sv"

echo "=========== 自检 TB (G-C-04 / G-C-05) ==========="
xelab --relax -debug typical -s tb_self work.tb_sync_top
xsim tb_self -runall

echo "=========== cosim TB (G-B-03) ==========="
xelab --relax -debug typical -s tb_cosim work.tb_sync_cosim
xsim tb_cosim -runall

echo "=========== 产出 ==========="
ls -1 ./*.json ./stability/*.json 2>/dev/null || true

if [ "$INSTALL" = "--install" ]; then
    mkdir -p "$EVID/stability"
    cp alignment-report.json "$EVID/alignment-report.json"
    cp reset-sim.json        "$EVID/reset-sim.json"
    for s in regression boundary backpressure stress; do
        cp "stability/$s.json" "$EVID/stability/$s.json"
    done
    echo "证据已安装到 $EVID"
else
    echo "(未安装; 加 --install 才写入 $EVID)"
fi
