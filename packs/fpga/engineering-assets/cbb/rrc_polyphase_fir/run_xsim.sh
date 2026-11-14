#!/usr/bin/env bash
# Vivado xsim 验证入口 — rrc_polyphase_fir 核级 (与 run.do 同一 TB, 同一判据)
#
# 用法 (任意目录):  bash <PKG>/run_xsim.sh
# 构建产物落在 $ROOT/var/build/rrc_polyphase_fir, 不污染资产包 (治理规范 §5.5)。
#
# 为什么要有这条通路: 本机 ModelSim 10.6c 的 vish/vsim 回环 RPC 自 2026-08-01 起
# 故障 (IPv6 ::1 可 bind 不可 connect), 任何设计都无法加载 —— run.do 那条路当前
# 跑不通, 也就意味着本资产的仿真证据无法复现。库内其余资产已统一改用 xsim,
# 本脚本把 rrc 也接上, 两条通路互为交叉验证, 结论一致即可采信。
#
# 路径注入: xsim 的 -testplusarg 在 Windows 上传不了含盘符的路径 (`C:/...` 的冒号
# 会与 `=` 一起把参数切碎), 所以这里不传 +VEC_DIR/+RPT_F/+EVID_DIR ——
# 改为先把向量拷进构建目录、让 TB 按**运行目录相对**读写, 跑完再把证据搬到
# 门禁约定位置。TB 侧的回落逻辑见 tb_rrc_polyphase_fir.sv 的对应注释。
set -euo pipefail

PKG="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$PKG"
while [ "$(basename "$ROOT")" != "engineering-assets" ] && [ "$ROOT" != "/" ]; do
    ROOT="$(dirname "$ROOT")"
done
BUILD="$ROOT/var/build/rrc_polyphase_fir"
VEC="$ROOT/models/comm/rrc/vectors"
EVID="$ROOT/var/gates/pg/rrc_polyphase_fir"

rm -rf "$BUILD"
mkdir -p "$BUILD/stability"
cd "$BUILD"

# 向量权威位置仍是 models/comm/rrc/vectors/ (治理规范 §5.5); 这里只是把它拷进
# 运行目录供 TB 相对读取, 不构成第二份权威副本 —— 每次运行前都重新拷。
cp "$VEC/rrc_stimulus.hex" "$VEC/expected_tx.hex" .

echo "=========== XVLOG ANALYZE ==========="
xvlog -sv --relax "$PKG/rtl/rrc_polyphase_fir.sv" "$PKG/tb/tb_rrc_polyphase_fir.sv"

echo "=========== XELAB ==========="
xelab --relax -debug typical -s tb_sim work.tb_rrc_polyphase_fir

echo "=========== XSIM RUN ==========="
# 工具名经文件注入而非 plusarg: xsim 的 -testplusarg 会在 `=` 处把参数切碎
# (实测 "Expected a switch but found V"), 与它传不了含盘符路径是同一个毛病。
# TB 读运行目录下的 sim-tool.txt, 路径无关, 两个仿真器都能用。
echo "Vivado-xsim-2023.1.1" > sim-tool.txt
xsim tb_sim -runall

echo "=========== 证据落地: $EVID ==========="
mkdir -p "$EVID/stability"
cp alignment-report.json "$EVID/alignment-report.json"
cp reset-sim.json        "$EVID/reset-sim.json"
for s in regression boundary backpressure stress; do
    cp "stability/$s.json" "$EVID/stability/$s.json"
done
echo "完成。"
