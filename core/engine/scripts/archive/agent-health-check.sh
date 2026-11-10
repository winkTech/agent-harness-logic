#!/bin/bash
# Agent 健康快速检查 — 定期执行
# 用法: bash scripts/agent-health-check.sh

cd "$(dirname "$0")/.." || exit 1

echo "========================================="
echo "  Agent 健康检查 $(date +%Y-%m-%d\ %H:%M)"
echo "========================================="

PASS=0
FAIL=0

check() {
  if [ "$1" -eq 0 ]; then
    echo "  ✅ $2"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $2"
    FAIL=$((FAIL + 1))
  fi
}

echo ""
echo "--- 1. 断裂链接 (跨 skill 引用) ---"
issues=$(find skills/ -name "*.md" -exec grep -l '\.\.[a-z-]*/SKILL\.md' {} \; \
  | while read f; do
    dir=$(dirname "$f")
    grep -oP '\(\.\.[^)]+\)' "$f" | tr -d '()' | while read link; do
      target="$dir/$link"
      [ ! -f "$target" ] && [ ! -d "$target" ] && echo "$f → $link"
    done
  done)
if [ -z "$issues" ]; then
  check 0 "无断裂跨 skill 引用"
else
  echo "$issues"
  check 1 "发现断裂跨 skill 引用"
fi

echo ""
echo "--- 2. SKILL.md reference 指针 ---"
ref_issues=""
for skill in hdl-coding tdd rag-skill; do
  [ -f "skills/$skill/SKILL.md" ] || continue
  bad=$(grep -oP '`references/[^`]+`' "skills/$skill/SKILL.md" | tr -d '`' \
    | while read ref; do
      [ ! -f "skills/$skill/$ref" ] && echo "skills/$skill/$ref 不存在"
    done)
  [ -n "$bad" ] && ref_issues="$ref_issues$bad"$'\n'
done
[ -z "$ref_issues" ] && check 0 "所有 reference 指针有效" || { echo "$ref_issues"; check 1 "发现无效 reference 指针"; }

echo ""
echo "--- 3. 缓存/孤立文件 ---"
pycache=$(find skills -name "__pycache__" -type d 2>/dev/null)
pyc=$(find skills -name "*.pyc" -type f 2>/dev/null)
gitkeep=$(find skills -name ".gitkeep" -type f 2>/dev/null)
[ -z "$pycache$pyc$gitkeep" ] && check 0 "无缓存/孤立文件" || {
  [ -n "$pycache" ] && echo "  __pycache__: $(echo "$pycache" | wc -l) 个目录"
  [ -n "$pyc" ] && echo "  .pyc: $(echo "$pyc" | wc -l) 个文件"
  [ -n "$gitkeep" ] && echo "  .gitkeep: $(echo "$gitkeep" | wc -l) 个文件"
  check 1 "存在缓存/孤立文件"
}

echo ""
echo "--- 4. 大文件 (>500K, 非 md) ---"
big=$(find skills -type f ! -name "*.md" -size +500k 2>/dev/null)
[ -z "$big" ] && check 0 "无 >500K 非 md 文件" || { echo "$big"; check 1 "存在大文件"; }

echo ""
echo "--- 5. 记忆系统死引用 ---"
# 提取 [[name]] 但排除代码块内的 (``` 之间的内容), 排除 [[name]] 自身引用
dead=$(for f in memory/*/*.md; do
  # 移除代码块，再扫描 [[name]]
  awk 'BEGIN{inblock=0} /^```/{inblock=!inblock; next} !inblock' "$f" 2>/dev/null \
    | grep -oP '\[\[([^\]]+)\]\]' | sed 's/\[\[//; s/\]\]//' \
    | while read name; do
      [ "$name" = "name" ] && continue  # 跳过行内引用
      grep -q "^name: $name$" memory/*/*.md 2>/dev/null || echo "$f → [[$name]]"
    done
done)
[ -z "$dead" ] && check 0 "记忆引用全部有效" || { echo "$dead"; check 1 "存在记忆死引用"; }

echo ""
echo "--- 6. 配置一致性 ---"
conf_issues=""
while IFS= read -r path; do
  [ -z "$path" ] && continue
  if echo "$path" | grep -q "^skills/"; then
    [ -f "$path" ] || conf_issues="$conf_issues  ❌ $path 不存在"$'\n'
  else
    [ -f "skills/$path" ] || [ -f "$path" ] || conf_issues="$conf_issues  ❌ skills/$path 不存在"$'\n'
  fi
done < <(grep -oP '`[^`]+SKILL\.md`' CLAUDE.md | tr -d '`')
[ -z "$conf_issues" ] && check 0 "CLAUDE.md 配置有效" || { echo "$conf_issues"; check 1 "CLAUDE.md 需要更新"; }

echo ""
echo "========================================="
echo "  结果: ✅ $PASS 通过"
[ "$FAIL" -gt 0 ] && echo "        ❌ $FAIL 需修复"
echo "========================================="
