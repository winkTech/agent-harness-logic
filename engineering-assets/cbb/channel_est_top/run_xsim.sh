#!/usr/bin/env bash
# Vivado xsim 验证入口 — channel_est_top (与 tb/run_sim.do + tb/run_cosim.do 同一
# 组 TB、同一套判据, 两条通路互为交叉验证)
#
# 用法 (任意目录):  bash <PKG>/run_xsim.sh [--install]
#   不带 --install: 证据留在构建目录, 便于与既有证据比对
#   带   --install: 搬到 var/gates/pg/channel_est_top/
#
# 为什么需要它: 本机 ModelSim 回环 RPC 自 2026-08-01 起故障, .do 那条路跑不通,
# 本资产的 certified 证据无法复现。
#
# 路径注入: xsim 的 -testplusarg 在 Windows 上传不了含盘符的路径 (`=` 与冒号处
# 会把参数切碎), 故不传 +VEC_DIR/+EVID_DIR —— 先把向量拷进构建目录, 让 TB 按
# 运行目录相对读写, 跑完再搬。TB 侧回落逻辑见两个 tb 文件的对应注释。
set -euo pipefail

PKG="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$PKG"
while [ "$(basename "$ROOT")" != "engineering-assets" ] && [ "$ROOT" != "/" ]; do
    ROOT="$(dirname "$ROOT")"
done
BUILD="$ROOT/var/build/channel_est_top"
VEC="$ROOT/models/comm/channel_est/vectors"
EVID="$ROOT/var/gates/pg/channel_est_top"
INSTALL="${1:-}"

# 构建目录放在 var/build/ 而不是包内。tb/run_sim.do 与 tb/run_cosim.do 用的是
# `set BUILD [file join $ROOT var_build]` (ROOT = 包根), 会在资产包里长出
# var_build/ —— 2026-08-02 实测那里堆了 ModelSim work 库与 transcript, 已清理。
rm -rf "$BUILD"
mkdir -p "$BUILD/stability"
cd "$BUILD"

# 向量权威位置仍是 models/comm/channel_est/vectors/ (治理规范 §5.5);
# 这里只是拷进运行目录供 TB 相对读取, 每次运行前重拷, 不构成第二份权威副本。
cp "$VEC/rx_chEst_frame.hex" "$VEC/expected_chEst_frame.hex" .

RTL=(
    "$PKG/rtl/cordic_cv.sv"
    "$PKG/rtl/lts_estimator.sv"
    "$PKG/rtl/cpe_rotate_out.sv"
    "$PKG/rtl/cpe_tracker.sv"
    "$PKG/rtl/channel_est_top.sv"
)

# 工具名经文件注入: xsim 的 -testplusarg 会在 `=` 处把参数切碎, 传不了
echo "Vivado-xsim-2023.1.1" > sim-tool.txt

echo "=========== XVLOG ==========="
xvlog -sv --relax "${RTL[@]}" "$PKG/tb/tb_channel_est_top.sv" "$PKG/tb/tb_chEst_cosim.sv"

echo "=========== 自检 TB (G-C-04 / G-C-05) ==========="
xelab --relax -debug typical -s tb_self work.tb_channel_est_top
xsim tb_self -runall

echo "=========== cosim TB (G-B-03) ==========="
xelab --relax -debug typical -s tb_cosim work.tb_chEst_cosim
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
    # RTL 输出转储属调试观测, 与门禁证据同放证据目录 (它不是 golden 期望值)
    [ -f rtl_chEst_frame_out.hex ] && cp rtl_chEst_frame_out.hex "$EVID/"
    echo "证据已安装到 $EVID"
else
    echo "(未安装; 加 --install 才写入 $EVID)"
fi
