#!/bin/bash
# ============================================================================
# Plugins 缓存归档脚本
# 用途: 将 plugins/cache/ 下的缓存文件归档为压缩包，释放磁盘空间
# 注意: 归档后原始缓存文件保留，如需删除请手动执行
#       缓存文件会被 Claude Code 自动重新生成（按需下载）
# ============================================================================
#
# 用法:
#   ./scripts/archive-plugin-cache.sh              # 归档全部缓存
#   ./scripts/archive-plugin-cache.sh --delete      # 归档后删除原始文件
#   ./scripts/archive-plugin-cache.sh --restore     # 从最新归档恢复
#
# 依赖: tar, gzip (Git Bash 环境下可用)
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PLUGINS_CACHE="$PROJECT_ROOT/plugins/cache"
ARCHIVE_DIR="$PROJECT_ROOT/plugins/.cache-archive"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
ARCHIVE_NAME="plugin-cache-${TIMESTAMP}.tar.gz"
MANIFEST_NAME="cache-manifest-${TIMESTAMP}.txt"

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# ============================================================================
# 检查环境
# ============================================================================
check_prereqs() {
    if ! command -v tar &> /dev/null; then
        echo -e "${RED}[ERROR] tar not found. Install Git Bash or tar utility.${NC}"
        exit 1
    fi
    if [ ! -d "$PLUGINS_CACHE" ]; then
        echo -e "${YELLOW}[WARN] plugins/cache directory not found: $PLUGINS_CACHE${NC}"
        echo "  Nothing to archive."
        exit 0
    fi
}

# ============================================================================
# 归档缓存
# ============================================================================
archive_cache() {
    local delete_after=$1

    echo -e "${GREEN}=== Plugins Cache Archiver ===${NC}"
    echo "  Source:   $PLUGINS_CACHE"
    echo "  Archive:  $ARCHIVE_DIR/$ARCHIVE_NAME"
    echo ""

    # 计算归档前大小
    local before_size
    before_size=$(du -sh "$PLUGINS_CACHE" 2>/dev/null | cut -f1)
    local before_bytes
    before_bytes=$(du -sb "$PLUGINS_CACHE" 2>/dev/null | cut -f1)

    echo -e "  Cache size before: ${YELLOW}$before_size${NC}"
    echo ""

    # 创建归档目录
    mkdir -p "$ARCHIVE_DIR"

    # 生成文件清单
    echo "Generating file manifest..."
    find "$PLUGINS_CACHE" -type f -ls > "$ARCHIVE_DIR/$MANIFEST_NAME" 2>/dev/null || true
    find "$PLUGINS_CACHE" -type f -name "*.json" -exec wc -c {} + >> "$ARCHIVE_DIR/$MANIFEST_NAME" 2>/dev/null || true

    # 创建压缩归档
    echo "Creating archive: $ARCHIVE_NAME"
    cd "$PROJECT_ROOT" || exit 1

    if tar czf "$ARCHIVE_DIR/$ARCHIVE_NAME" \
        -C "$(dirname "$PLUGINS_CACHE")" \
        "$(basename "$PLUGINS_CACHE")" 2>&1; then

        local archive_size
        archive_size=$(du -h "$ARCHIVE_DIR/$ARCHIVE_NAME" 2>/dev/null | cut -f1)
        echo -e "${GREEN}  Archive created: $ARCHIVE_DIR/$ARCHIVE_NAME${NC}"
        echo -e "  Archive size:    ${YELLOW}$archive_size${NC}"

        # 压缩率
        local archive_bytes
        archive_bytes=$(du -sb "$ARCHIVE_DIR/$ARCHIVE_NAME" 2>/dev/null | cut -f1)
        if [ "$before_bytes" -gt 0 ] && [ "$archive_bytes" -gt 0 ]; then
            local ratio
            ratio=$(echo "scale=1; 100 * $archive_bytes / $before_bytes" | bc 2>/dev/null || echo "?")
            echo -e "  Compression:     ${YELLOW}${ratio}%${NC} of original"
        fi

        # 删除原始缓存 (如果指定 --delete)
        if [ "$delete_after" = true ]; then
            echo ""
            echo -e "${YELLOW}Deleting original cache files...${NC}"
            rm -rf "$PLUGINS_CACHE"/*
            local after_size
            after_size=$(du -sh "$PLUGINS_CACHE" 2>/dev/null | cut -f1)
            echo -e "${GREEN}  Cache cleared. Current cache size: $after_size${NC}"
        fi

        # 写入存档元信息
        cat > "$ARCHIVE_DIR/archive-info.txt" <<INF
Archive:     $ARCHIVE_NAME
Date:        $(date)
Source:      plugins/cache/
Size before: $before_size
Archive sz:  $archive_size
Content:     Plugin skill caches (re-downloadable from marketplace)
INF

        echo ""
        echo -e "${GREEN}=== Done ===${NC}"
        echo "  To restore: tar xzf $ARCHIVE_DIR/$ARCHIVE_NAME -C $PROJECT_ROOT/plugins"
        echo "  Manifest:   $ARCHIVE_DIR/$MANIFEST_NAME"
    else
        echo -e "${RED}[ERROR] Archive creation failed${NC}"
        rm -f "$ARCHIVE_DIR/$ARCHIVE_NAME"
        exit 1
    fi
}

# ============================================================================
# 从归档恢复
# ============================================================================
restore_cache() {
    local latest_archive
    latest_archive=$(ls -t "$ARCHIVE_DIR"/plugin-cache-*.tar.gz 2>/dev/null | head -1)

    if [ -z "$latest_archive" ]; then
        echo -e "${RED}[ERROR] No archive found in $ARCHIVE_DIR${NC}"
        exit 1
    fi

    echo -e "${GREEN}Restoring from: $latest_archive${NC}"
    tar xzf "$latest_archive" -C "$PROJECT_ROOT/plugins"
    echo -e "${GREEN}Restore complete.${NC}"
}

# ============================================================================
# Main
# ============================================================================
main() {
    check_prereqs

    case "${1:-}" in
        --delete|-d)
            archive_cache true
            ;;
        --restore|-r)
            restore_cache
            ;;
        *)
            archive_cache false
            ;;
    esac
}

main "$@"
