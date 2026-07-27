#!/bin/bash
# Batch-add name: field to knowledge base .md files missing it
# Usage: ./add_name_frontmatter.sh [--dry-run]

BASE="/c/Users/Lihan/.claude"
DRY_RUN=false

if [[ "$1" == "--dry-run" ]]; then
    DRY_RUN=true
fi

echo "========================================================"
if $DRY_RUN; then
    echo "DRY-RUN MODE - no files will be modified"
else
    echo "Adding name: field to .md files missing frontmatter name"
fi
echo "========================================================"

total_modified=0
total_scanned=0

# Function to generate slug from filepath
generate_slug() {
    local filepath="$1"
    local filename=$(basename "$filepath")
    local stem="${filename%.md}"

    if [[ "${stem,,}" == "readme" ]]; then
        # Use parent directory name
        local parent=$(basename "$(dirname "$filepath")")
        echo "$parent" | tr '[:upper:]' '[:lower:]' | tr '_ ' '--' | sed 's/-\+/-/g' | sed 's/^-//;s/-$//'
        return
    fi

    echo "$stem" | tr '[:upper:]' '[:lower:]' | tr '_ ' '--' | sed 's/-\+/-/g' | sed 's/^-//;s/-$//'
}

# Function to check if file already has name: field (in frontmatter or at start)
has_name_field() {
    local filepath="$1"
    # Check for name: in first 50 lines (frontmatter)
    head -50 "$filepath" | grep -qE '^name:\s+\S'
    return $?
}

# Function to add name: to a file
add_name() {
    local filepath="$1"
    local slug="$2"

    # Read the file
    local content=$(cat "$filepath")

    # Check if file starts with --- (YAML frontmatter)
    if head -1 "$filepath" | grep -q '^---$'; then
        # Has YAML frontmatter: insert name: after first --- line
        # Use awk: find first ---, print it, then print "name: <slug>", then print rest
        awk -v slug="$slug" '
        BEGIN { fm_closed = 0; first_seen = 0 }
        {
            if (!first_seen && $0 == "---") {
                print
                print "name: " slug
                first_seen = 1
            }
            else {
                print
            }
        }' "$filepath" > "${filepath}.tmp"
    else
        # No frontmatter: add one
        {
            echo "---"
            echo "name: $slug"
            echo "---"
            echo ""
            cat "$filepath"
        } > "${filepath}.tmp"
    fi

    mv "${filepath}.tmp" "$filepath"
}

# Process target directories
process_dir() {
    local rel_dir="$1"
    local dirpath="$BASE/$rel_dir"

    if [[ ! -d "$dirpath" ]]; then
        echo "  SKIP (not found): $rel_dir"
        return
    fi

    echo ""
    echo "--- Scanning: $rel_dir ---"

    # Find all .md files, excluding examples and golden_model paths
    while IFS= read -r -d '' md_file; do
        # Skip files in examples/ or golden_model/ directories
        case "$md_file" in
            */examples/*|*/golden_model/*)
                continue ;;
        esac

        total_scanned=$((total_scanned + 1))
        local relpath="${md_file#$BASE/}"

        if has_name_field "$md_file"; then
            continue  # Already has name:
        fi

        local slug=$(generate_slug "$md_file")

        if $DRY_RUN; then
            echo "  [DRY-RUN] Would modify: $relpath (name: $slug)"
        else
            add_name "$md_file" "$slug"
            echo "  MODIFIED: $relpath -> name: $slug"
        fi

        total_modified=$((total_modified + 1))
    done < <(find "$dirpath" -name '*.md' -type f -print0)
}

# All knowledge base directories
process_dir "engineering-assets/knowledge/primary"
process_dir "engineering-assets/knowledge/docs"
process_dir "engineering-assets/knowledge/archive"
process_dir "engineering-assets/knowledge/references"
process_dir "engineering-assets/reference-assets/datasheets"
process_dir "engineering-assets/knowledge/methodology"
process_dir "engineering-assets/knowledge/math-foundation"
process_dir "engineering-assets/knowledge/linear-algebra"
process_dir "engineering-assets/knowledge/probability-statistics"
process_dir "engineering-assets/knowledge/python-basics"
process_dir "engineering-assets/knowledge/data-viz"

echo ""
echo "========================================================"
echo "Scanned: $total_scanned files"
echo "Modified: $total_modified files"
if $DRY_RUN; then
    echo "NOTE: Dry-run mode, no actual changes made."
fi
echo "========================================================"

# Final verification
if ! $DRY_RUN; then
    echo ""
    echo "========================================================"
    echo "Verification: checking coverage..."
    echo "========================================================"
    still_missing=0

    while IFS= read -r -d '' md_file; do
        case "$md_file" in
            */examples/*|*/golden_model/*)
                continue ;;
        esac
        if ! has_name_field "$md_file"; then
            echo "  STILL MISSING: ${md_file#$BASE/}"
            still_missing=$((still_missing + 1))
        fi
    ALL_KNOWLEDGE_DIRS=""
    for d in engineering-assets/knowledge/primary engineering-assets/knowledge/docs engineering-assets/knowledge/archive engineering-assets/knowledge/references engineering-assets/reference-assets/datasheets engineering-assets/knowledge/methodology engineering-assets/knowledge/math-foundation engineering-assets/knowledge/linear-algebra engineering-assets/knowledge/probability-statistics engineering-assets/knowledge/python-basics engineering-assets/knowledge/data-viz; do
        ALL_KNOWLEDGE_DIRS="$ALL_KNOWLEDGE_DIRS $BASE/$d"
    done
    done < <(find $ALL_KNOWLEDGE_DIRS -name '*.md' -type f -print0 2>/dev/null)

    if [[ $still_missing -eq 0 ]]; then
        echo "  All files now have name: field. Coverage: 100%"
    else
        echo "  Files still missing name:: $still_missing"
    fi
fi
