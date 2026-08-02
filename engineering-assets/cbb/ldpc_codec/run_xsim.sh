#!/usr/bin/env bash
# Vivado xsim 验证入口 — ldpc_codec (与 tb/run_sim.do 同一组 TB、同一套判据)
#
# 用法 (任意目录):  bash <PKG>/run_xsim.sh [--install]
#
# 为什么需要它: 本机 ModelSim 回环 RPC 自 2026-08-01 起故障, run_sim.do 跑不通,
# 本资产的 certified 证据无法复现。
#
# 本包与其它资产的不同之处:
#   - RTL 是 Verilog-2001 (.v) + ldpc_defines.vh, 需要 +incdir
#   - 两个顶层: ldpc_decoder_top (主资产, 出 G-B-03/G-C-04/G-C-05 证据) 与
#     ldpc_encoder_top (第二顶层, 5 组 bit-true)
#   - 编码器的 PT ROM 用 $readmemb 相对当前目录读, 故须把 pt_columns.hex
#     拷进运行目录 (见 ldpc_encoder_top 头注释)
set -euo pipefail

PKG="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$PKG"
while [ "$(basename "$ROOT")" != "engineering-assets" ] && [ "$ROOT" != "/" ]; do
    ROOT="$(dirname "$ROOT")"
done
BUILD="$ROOT/var/build/ldpc_codec"
VEC="$ROOT/models/comm/ldpc/vectors"
EVID="$ROOT/var/gates/pg/ldpc_codec"
INSTALL="${1:-}"

rm -rf "$BUILD"
mkdir -p "$BUILD/stability" "$BUILD/trace"
cd "$BUILD"

# 向量权威位置仍是 models/comm/ldpc/vectors/; 这里只是拷进运行目录供 TB 相对读取
cp "$VEC"/tb_llr_input_*.hex "$VEC"/tb_expected_output_*.hex \
   "$VEC"/tb_enc_info_*.hex  "$VEC"/tb_enc_code_*.hex .
# PT ROM: 编码器 RTL 以相对路径 $readmemb 读它
cp "$PKG/rtl/pt_columns.hex" .

echo "Vivado-xsim-2023.1.1" > sim-tool.txt

echo "=========== XVLOG ==========="
xvlog -sv --relax -i "$PKG/rtl" \
    "$PKG/rtl/h_matrix_addr.v" \
    "$PKG/rtl/llr_buffer.v" \
    "$PKG/rtl/msg_buffer.v" \
    "$PKG/rtl/cn_update.v" \
    "$PKG/rtl/early_term.v" \
    "$PKG/rtl/ldpc_controller.v" \
    "$PKG/rtl/ldpc_stream_io.v" \
    "$PKG/rtl/ldpc_decoder_top.v" \
    "$PKG/rtl/ldpc_encoder_top.v" \
    "$PKG/tb/tb_ldpc_decoder_top.v" \
    "$PKG/tb/tb_ldpc_encoder_top.v"

echo "=========== 译码器 TB (G-B-03 / G-C-04 / G-C-05) ==========="
xelab --relax -debug typical -s tb_dec work.tb_ldpc_decoder_top
xsim tb_dec -runall

echo "=========== 编码器 TB (bit-true 5 组) ==========="
xelab --relax -debug typical -s tb_enc work.tb_ldpc_encoder_top
xsim tb_enc -runall

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
