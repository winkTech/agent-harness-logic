#!/usr/bin/env bash
# 原语 CBB 的仿真复现入口 —— 一个脚本服务全部自包含 TB 的原语包
#
# 用法:  bash tools/run-primitive-sim.sh <asset_uid> [--install]
#   不带 --install: 只跑, 证据留在构建目录, 便于与既有证据比对
#   带   --install: 跑完把证据搬到 var/gates/pg/<asset_uid>/ (门禁约定位置)
#
# 为什么需要它 (2026-08-02 普查结论):
#   本次认证的 8 个原语包里只有 tb_*.sv, **没有任何运行脚本**, README 与 docs 里
#   也从未写下那次 xvlog/xelab/xsim 的具体调用 —— 只在 limitations 留了一句
#   "证据由 Vivado xsim 2023.1 产出"。也就是说它们的 certified 证据事实上
#   **无法被任何人重新生成**, 包括当初跑它的人。G-GATE-01 只检查证据文件在不在,
#   不检查证据能不能被重做, 所以这个洞可以一路通过认证。
#
# 为什么是一个共用脚本而不是 8 份 run_xsim.sh:
#   这 8 个包的形态完全一致 —— 顶层 TB 模块名恒为 tb_<asset_uid>, TB 自包含
#   (无外部向量、无 plusarg 路径注入), 证据一律以固定文件名写在运行目录:
#     stability-{regression,boundary,backpressure,stress}.json / reset-sim.json /
#     tb-selfcheck.json
#   复制 8 份只会带来 8 份各自漂移的副本。若将来某个包长出特殊需求 (外部向量、
#   多时钟、需要 plusarg), 再给那个包单独写 run_xsim.sh, 本脚本不拦。
set -euo pipefail

UID_ARG="${1:-}"
INSTALL="${2:-}"
if [ -z "$UID_ARG" ]; then
    echo "用法: bash tools/run-primitive-sim.sh <asset_uid> [--install]" >&2
    exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG="$ROOT/cbb/$UID_ARG"
BUILD="$ROOT/var/build/$UID_ARG"
EVID="$ROOT/var/gates/pg/$UID_ARG"

[ -d "$PKG" ] || { echo "找不到包: $PKG" >&2; exit 2; }

TB_SRC="$PKG/tb/tb_${UID_ARG}.sv"
[ -f "$TB_SRC" ] || { echo "找不到 TB: $TB_SRC" >&2; exit 2; }

# RTL 源取包内 rtl/ 下全部 .sv/.v; 顺序交给 xvlog --relax 处理 (无包/接口依赖)
RTL_SRCS=()
while IFS= read -r f; do RTL_SRCS+=("$f"); done < <(find "$PKG/rtl" -maxdepth 1 \( -name '*.sv' -o -name '*.v' \) | sort)
[ "${#RTL_SRCS[@]}" -gt 0 ] || { echo "$PKG/rtl 下没有 RTL 源" >&2; exit 2; }

rm -rf "$BUILD"
mkdir -p "$BUILD"
cd "$BUILD"

echo "=========== [$UID_ARG] XVLOG ==========="
xvlog -sv --relax "${RTL_SRCS[@]}" "$TB_SRC"

echo "=========== [$UID_ARG] XELAB ==========="
xelab --relax -debug typical -s tb_sim "work.tb_${UID_ARG}"

echo "=========== [$UID_ARG] XSIM ==========="
xsim tb_sim -runall

echo "=========== [$UID_ARG] 产出 ==========="
ls -1 ./*.json 2>/dev/null || true

if [ "$INSTALL" = "--install" ]; then
    mkdir -p "$EVID/stability"
    cp reset-sim.json    "$EVID/reset-sim.json"
    cp tb-selfcheck.json "$EVID/tb-selfcheck.json"
    # TB 以扁平名 stability-<s>.json 写出, 门禁约定的位置是 stability/<s>.json
    for s in regression boundary backpressure stress; do
        cp "stability-$s.json" "$EVID/stability/$s.json"
    done
    echo "证据已安装到 $EVID"
else
    echo "(未安装; 加 --install 才写入 $EVID)"
fi
