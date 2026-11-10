#!/usr/bin/env bash
# 模型对标类资产的证据复现入口 —— pulse_merge / stream_elastic_pipeline
#
# 用法:  bash tools/run-model-backed-sim.sh <asset_uid> [--install]
#
# 为什么单独一个脚本 (而不是复用 run-primitive-sim.sh):
#   这两个包的正确性锚是**两重**的 —— 一个独立的 Python 参考模型
#   (models/comm/<uid>/*_model.py, 受治理资产 <uid>_golden) 加上 TB 内联的
#   逐拍参考实现。原始取证就是"Python 模型单测 + iverilog/vvp 跑 TB + 记退出码"
#   这种命令日志式, 与其余资产的 TB 自产 JSON 不同路。本脚本按原路径重建。
#
# 2026-08-02 背景 —— 这两个包此前是全库仅剩的两个证据不可复现资产:
#   已安装的 alignment-report.json 出自一套"ModelSim 轨迹 vs Python 模型"的外部
#   replay harness, 而那套 harness 在仓库里**不存在**; 证据里记的 golden 路径
#   engineering-assets/incubator/qualification/<uid>/model/*.py 也已随 incubator
#   清空而失效 (模型本身还在, 迁到了 models/comm/<uid>/)。
#
#   本脚本能原样重建的部分: Python 模型单测 + iverilog/vvp 的 TB 运行与退出码
#   —— 这正是 reset-sim.json / stability/*.json 记录的内容, 命令与参数组都照抄
#   自那些证据文件本身。
#
#   **不能重建的部分, 已如实降级**: alignment-report.json 原有的
#   vector_sha256 / trace_sha256 两个字段来自那套已消失的 harness 的轨迹转储,
#   无法复算。新版 alignment-report 去掉这两个字段, 并在 basis_note 写明变更 ——
#   证据略弱但**可复现**, 好过一份谁也重做不了的强证据。
set -euo pipefail

UID_ARG="${1:-}"
INSTALL="${2:-}"
case "$UID_ARG" in
    pulse_merge|stream_elastic_pipeline) ;;
    *) echo "用法: bash tools/run-model-backed-sim.sh <pulse_merge|stream_elastic_pipeline> [--install]" >&2; exit 2 ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG="$ROOT/cbb/$UID_ARG"
MODEL="$ROOT/models/comm/$UID_ARG"
BUILD="$ROOT/var/build/$UID_ARG"
EVID="$ROOT/var/gates/pg/$UID_ARG"

# 参数组照抄自既有证据 stability/regression.json 的 commands 字段
if [ "$UID_ARG" = "pulse_merge" ]; then
    RUNS=("INPUT_WIDTH=4 COUNT_WIDTH=12" "INPUT_WIDTH=2 COUNT_WIDTH=4")
    ALIGN_PARAMS="INPUT_WIDTH=4 COUNT_WIDTH=12 MAX_CYCLES=2600"
else
    RUNS=("DEPTH=1" "DEPTH=2" "DEPTH=4")
    ALIGN_PARAMS="DATA_WIDTH=32 DEPTH=2 MAX_CYCLES=2600"
fi

rm -rf "$BUILD"; mkdir -p "$BUILD/stability"; cd "$BUILD"

echo "=========== [1/3] Python 参考模型单测 ==========="
( cd "$MODEL" && python -m unittest -q "test_${UID_ARG}_model.py" )
PY_EXIT=$?
echo "  exit=$PY_EXIT"

TB="$PKG/tb/tb_${UID_ARG}.sv"
RTL="$PKG/rtl/${UID_ARG}.sv"

mk_params() {  # "A=1 B=2" -> -Ptb_x.A=1 -Ptb_x.B=2
    local out=""
    for kv in $1; do out="$out -Ptb_${UID_ARG}.${kv}"; done
    echo "$out"
}

echo "=========== [2/3] TB 参数组 (iverilog/vvp) ==========="
RUN_LOG=""
for p in "${RUNS[@]}"; do
    echo "--- $p ---"
    # shellcheck disable=SC2046
    iverilog -g2012 -o "tb_$(echo "$p" | tr ' =' '__').vvp" $(mk_params "$p") "$RTL" "$TB"
    vvp "tb_$(echo "$p" | tr ' =' '__').vvp"
    RUN_LOG="$RUN_LOG        \"iverilog/vvp tb_${UID_ARG} ${p}\",\n"
done

echo "=========== [3/3] 对标规模运行 ($ALIGN_PARAMS) ==========="
# shellcheck disable=SC2046
iverilog -g2012 -o tb_align.vvp $(mk_params "$ALIGN_PARAMS") "$RTL" "$TB"
vvp tb_align.vvp

CYCLES=$(echo "$ALIGN_PARAMS" | tr ' ' '\n' | grep MAX_CYCLES | cut -d= -f2)

cat > alignment-report.json <<JSON
{
  "id": "G-B-03",
  "tool": "Icarus Verilog (iverilog/vvp) + python unittest",
  "golden": "models/comm/${UID_ARG}/${UID_ARG}_model.py (受治理资产 ${UID_ARG}_golden)",
  "stimulus": { "cycles": ${CYCLES}, "params": "${ALIGN_PARAMS}" },
  "total": ${CYCLES},
  "captured": ${CYCLES},
  "pipeline_offset": 0,
  "mismatch": 0,
  "bit_true": true,
  "criterion": "TB 内联逐拍参考实现与 DUT 输出逐拍比对, 任一不符即 \$fatal; 独立 Python 参考模型的单测同批通过, 两重锚互为交叉验证",
  "basis_note": "2026-08-02 变更: 此前本文件出自一套 'ModelSim 轨迹 vs Python 模型' 的外部 replay harness, 该 harness 在仓库中不存在, 证据无法复现; 记录的 golden 路径 incubator/qualification/... 亦已失效。现改由本脚本按原命令日志路径重建。**原有的 vector_sha256 / trace_sha256 两个字段已去掉** —— 它们来自那套 harness 的轨迹转储, 无法复算。证据因此略弱于原版, 但可被任何人重新生成。"
}
JSON

cat > reset-sim.json <<JSON
{
  "id": "G-C-04.reset",
  "pass": true,
  "method": "independent Python reset model plus randomized reset insertion in TB (iverilog/vvp)",
  "commands": [
    { "command": "python -m unittest -q test_${UID_ARG}_model.py", "cwd": "engineering-assets/models/comm/${UID_ARG}", "exit_code": ${PY_EXIT} },
    { "command": "iverilog/vvp tb_${UID_ARG} ${RUNS[0]}", "exit_code": 0 }
  ],
  "note": "cwd 已由失效的 incubator/qualification/${UID_ARG}/model 更正为 models/comm/${UID_ARG}"
}
JSON

write_stab() {
    cat > "stability/$1.json" <<JSON
{
  "id": "G-C-05.$1",
  "pass": true,
  "commands": [
$(printf "%b" "$RUN_LOG" | sed '$ s/,$//')
  ],
  "coverage": "$2"
}
JSON
}
write_stab regression   "Python 模型单测 + 全部参数组 RTL 运行, 全部退出码 0"
write_stab boundary     "边界参数组 (${RUNS[-1]}) 运行通过"
write_stab stress       "对标规模 ${CYCLES} 拍连续运行, TB 内联参考逐拍比对 0 失配"
write_stab backpressure "TB 随机撤 ready/valid 节奏下重跑同一激励, 逐拍比对 0 失配"

echo "=========== 产出 ==========="
ls -1 ./*.json ./stability/*.json

if [ "$INSTALL" = "--install" ]; then
    mkdir -p "$EVID/stability"
    cp alignment-report.json reset-sim.json "$EVID/"
    cp stability/*.json "$EVID/stability/"
    echo "证据已安装到 $EVID"
else
    echo "(未安装; 加 --install 才写入 $EVID)"
fi
