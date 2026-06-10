#!/bin/bash
# 记忆检索 (v2.0)
# 四工具并行，覆盖域 0 重叠：
#   1. grep — 精确字面量（主力）
#   2. semantic-search — 跨词同义 + 概念查询（TF-IDF char n-gram）
#   3. code-graph — 代码调用链和符号定义
#   4. git log — 时间轴查询（CI 外由 Claude 直接执行）
#
# 用法: ./memory-retrieve.sh <搜索关键词>
# 输出: JSON lines，每行类型 + 路径 + 摘要

set -euo pipefail

QUERY="${1:-}"
if [ -z "$QUERY" ]; then
    echo '{"tool":"help","msg":"用法: ./memory-retrieve.sh <搜索关键词>"}'
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOME_DIR="$SCRIPT_DIR/../.."
ENGINE_SCRIPTS="$HOME_DIR/engine/scripts"
INDEX_DIR="$HOME_DIR/var/index"

mkdir -p "$INDEX_DIR"

# ── 0. SQLite FTS5 全文搜索 (Phase 1 新增, 优先) ─────────────────────
if command -v node &>/dev/null; then
    sqlite_out=$(node -e "
        var p = require('path');
        var mem = require(p.join(process.argv[1], 'engine', 'sqlite', 'store-memory.cjs'));
        try {
            var results = mem.retrieveMemory(process.argv[2], { limit: 5 });
            for (var r of results) {
                var snippet = r.content.replace(/\"/g,'\\\\\"').replace(/\n/g,' ').slice(0,200);
                console.log(JSON.stringify({tool:'sqlite-fts',id:r.id,ns:r.namespace,name:r.name||'',score:r.score.toFixed(3),snippet:snippet}));
            }
        } catch(e) { console.log(JSON.stringify({tool:'sqlite-fts-error',msg:'retrieve: '+e.message})); }
    " "$(cd "$HOME_DIR" && pwd)" "$QUERY" 2>/dev/null || true)

    if [ -n "$sqlite_out" ]; then
        echo "$sqlite_out"
    fi
fi

# ── 1. grep 精确匹配 ──────────────────────────────────────────────────
grep_hits=$(find "$HOME_DIR/memory" "$HOME_DIR/knowledge" -name "*.md" -not -name "MEMORY.md" -not -name "MEMORY_RULES.md" 2>/dev/null \
  | xargs grep -r -l -i "$QUERY" 2>/dev/null | head -10)

if [ -n "$grep_hits" ]; then
    echo "$grep_hits" | while IFS= read -r f; do
        rel="${f#$HOME_DIR/}"
        snippet=$(grep -i "$QUERY" "$f" 2>/dev/null | head -1 | sed 's/^[[:space:]]*//; s/[[:space:]]*$//; s/"/\\"/g')
        echo "{\"tool\":\"grep\",\"path\":\"$rel\",\"snippet\":\"${snippet:0:200}\"}"
    done
fi

# ── 2. Semantic search ─────────────────────────────────────────────────
if command -v node &>/dev/null && [ -f "$ENGINE_SCRIPTS/semantic-search.cjs" ]; then
    # Auto-build index if missing
    if [ ! -f "$INDEX_DIR/semantic-index.json" ]; then
        node "$ENGINE_SCRIPTS/semantic-search.cjs" index 2>/dev/null || true
    fi

    if [ -f "$INDEX_DIR/semantic-index.json" ]; then
        semantic_out=$(node "$ENGINE_SCRIPTS/semantic-search.cjs" query "$QUERY" --top 3 2>/dev/null || true)
        if [ -n "$semantic_out" ]; then
            # Prefix each JSON line from semantic search with tool type
            echo "$semantic_out" | node -e "
                const d=require('fs').readFileSync(0,'utf8');
                try {
                    const arr=JSON.parse(d);
                    for (const r of arr) {
                        const snippet=r.snippet?r.snippet.replace(/\"/g,'\\\"').slice(0,200):'';
                        console.log(JSON.stringify({tool:'semantic',path:r.path,score:r.score.toFixed(3),snippet}));
                    }
                } catch(e) { /* skip parse errors */ }
            " 2>/dev/null || true
        fi
    fi
fi

# ── 3. Code graph query ────────────────────────────────────────────────
if command -v node &>/dev/null && [ -f "$ENGINE_SCRIPTS/code-graph-index.cjs" ]; then
    if [ ! -f "$INDEX_DIR/code-graph.json" ]; then
        node "$ENGINE_SCRIPTS/code-graph-index.cjs" index 2>/dev/null || true
    fi

    if [ -f "$INDEX_DIR/code-graph.json" ]; then
        code_out=$(node "$ENGINE_SCRIPTS/code-graph-index.cjs" query "$QUERY" 2>/dev/null || true)
        if [ -n "$code_out" ]; then
            echo "$code_out" | node -e "
                const d=require('fs').readFileSync(0,'utf8');
                try {
                    const r=JSON.parse(d);
                    if (r.found && r.matches) {
                        for (const m of r.matches) {
                            console.log(JSON.stringify({tool:'code-graph',type:m.type,name:m.name,file:m.file,line:m.line}));
                        }
                    }
                } catch(e) {}
            " 2>/dev/null || true
        fi
    fi
fi
