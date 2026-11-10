---
name: agent-health-audit
description: Agent 健康审查清单 — 系统性扫描断裂链接、孤立文件、配置一致性、记忆系统完整性
metadata:
  type: learning
---

# Agent 健康审查规范

> 定期对 Agent 进行全量健康审查，防止配置腐烂（config rot）和文件碎片积累。

## 审查周期

- **全面审查**：每月一次，或完成大型重构后（如 Phase A-D 式优化）
- **快速审查**：每两周一次，用 `scripts/agent-health-check.sh`（见下文）

---

## 七维审查清单

### 1. 断裂链接扫描

扫描所有 `.md` 文件中的内部链接，验证目标存在：

```bash
# 提取所有 markdown 内部链接（not http/https）
grep -roP '\[([^\]]+)\]\(([^:http#][^)]*)\)' skills/ memory/ references/ \
  | while IFS= read -r line; do
  file=$(echo "$line" | cut -d: -f1)
  link=$(echo "$line" | grep -oP '\([^)]+\)' | tr -d '()')
  dir=$(dirname "$file")
  [ ! -f "$dir/$link" ] && echo "❌ $file → $link"
done
```

**已知高发区域**：
- `skills/*/references/` 中的文件引用上层目录路径（容易多一层 `../`）
- 旧合并技能的 README 文件（图片/文档断裂）
- 跨 skill 引用（如 `../gitflow/SKILL.md` 类型）

### 2. SKILL.md Reference 表验证

每个 SKILL.md 的 "参考文档" 表必须指向实际存在的文件：

```bash
for skill in hdl-coding tdd rag-skill; do
  grep -oP '`references/[^`]+`' skills/$skill/SKILL.md | tr -d '`' \
    | while read ref; do
      [ ! -f "skills/$skill/$ref" ] && echo "❌ skills/$skill/$ref 不存在"
    done
done
```

**Phase C 后检查要点**：reference 文件是从 `git HEAD` 提取的，后续编辑 SKILL.md 时如果新增 reference 条目，必须同步创建文件。

### 3. 记忆系统完整性

- 扫描 `memory/*/*.md` 中所有 `[[name]]` 引用，确保被引用的 `name:` 字段在另一文件中存在
- 检查 MEMORY.md 索引中的文件路径是否仍有效
- 检查是否有超过 90 天未更新的工作记忆（work/）— 归档或删除

```bash
# 检查 [[name]] 死链
for f in memory/*/*.md; do
  grep -oP '\[\[([^\]]+)\]\]' "$f" | sed 's/\[\[//; s/\]\]//' \
    | while read name; do
      grep -q "^name: $name$" memory/*/*.md || echo "⚠️  $f → [[$name]] 无匹配"
    done
done
```

### 4. 孤立文件清理

| 类型 | 扫描命令 | 说明 |
|:-----|:---------|:-----|
| `__pycache__` | `find skills -name __pycache__ -type d` | 编译缓存，可直接删 |
| `.pyc` | `find skills -name '*.pyc'` | 同上 |
| `.gitkeep` | `find skills -name .gitkeep` | 空目录占位，目录非空可删 |
| `node_modules/` | `find skills -name node_modules -type d` | 第三方依赖，按需保留 |
| `.git/` 子仓库 | `find skills -name .git -type d` | 嵌在 skills/ 内的独立 git 仓库 |
| >1MB 非 md 文件 | `find skills -type f ! -name '*.md' -size +1M` | 可能的大文件/资源误存放 |

### 5. 配置一致性

检查 `CLAUDE.md` 中引用的所有路径是否仍有效：

- Skill 入口：`skills/*/SKILL.md` 必须存在
- MCP 工具：确认 MCP 配置与实际可用工具一致
- Reference 索引：`references/reference-index.md` 中的链接

### 6. skills-catalog.md 与实际结构一致性

`references/skills-catalog.md` 应反映目录实际状态：

- `~~已合并~~` 标记的 skill → 检查 SKILL.md 是重定向桩（~1KB）
- 活跃的 skill → 检查 SKILL.md 有 `name:` + `description:` 元数据
- 不再存在的 skill → 在目录中标记或删除

### 7. 重复/冗余内容检测

- 相同主题在不同 skill 中是否有重复说明（如 CDC 处理）
- reference 文件中是否有大段重复内容
- 用 `fdupes` 或 `md5sum` 检测完全相同的文件

---

## 快速检查脚本

将以下脚本保存为 `scripts/agent-health-check.sh`，定期执行：

```bash
#!/bin/bash
# Agent 健康快速检查

echo "=== 1. 断裂链接 ==="
find skills/ -name "*.md" -exec grep -l '\.\./[a-z-]*/SKILL\.md' {} \; \
  | while read f; do
    grep -oP '\(\.\.[^)]+\)' "$f" | while read link; do
      dir=$(dirname "$f")
      target="$dir/$(echo $link | tr -d '()')"
      [ ! -f "$target" ] && [ ! -d "$target" ] && echo "❌ $f → $link"
    done
  done

echo "=== 2. SKILL.md reference 指针 ==="
for skill in hdl-coding tdd rag-skill; do
  [ -f "skills/$skill/SKILL.md" ] || continue
  grep -oP '`references/[^`]+`' "skills/$skill/SKILL.md" | tr -d '`' \
    | while read ref; do
      [ ! -f "skills/$skill/$ref" ] && echo "❌ skills/$skill/$ref 不存在"
    done
done

echo "=== 3. pycache / gitkeep ==="
find skills -name "__pycache__" -type d -o -name "*.pyc" -o -name ".gitkeep" 2>/dev/null

echo "=== 4. 大型非 md 文件 > 500K ==="
find skills -type f ! -name "*.md" -size +500k 2>/dev/null

echo "=== 5. 孤立记忆引用 ==="
for f in memory/*/*.md; do
  grep -oP '\[\[([^\]]+)\]\]' "$f" 2>/dev/null | sed 's/\[\[//; s/\]\]//' \
    | while read name; do
      grep -q "^name: $name$" memory/*/*.md 2>/dev/null || echo "⚠️  [[$name]] 无匹配"
    done
done

echo "=== 完成 ==="
```

---

## 清理命令速查

| 操作 | 命令 |
|:-----|:------|
| 删 pycache | `find skills -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null` |
| 删 .pyc | `find skills -name '*.pyc' -delete` |
| 删 .gitkeep | `find skills -name .gitkeep -delete` |
| 删 node_modules | `find skills -name node_modules -type d -exec rm -rf {} +` |
| 删零字节 | `find skills -size 0 -type f -delete` |
| 确认大文件 | `find skills -type f ! -name '*.md' -size +500k -exec ls -lh {} \;` |
| 统计目录大小 | `du -sh skills/*/ \| sort -rh` |
| 统计文件数 | `find skills -type f \| wc -l` |

---

## 关联

- [[agent-health-audit]] — 本规范
- [[lessons-summary]] — 经验教训汇总
- CLAUDE.md — Agent 核心配置
- `references/skills-catalog.md` — 技能目录

**Why**: Phase A-D 优化后积累了一套系统化审查方法，定期执行可防止 skills/ 重新膨胀到 240MB，确保记忆引用不腐烂。

**How to apply**: 每月首次会话运行完整审查（约 3 分钟），或重构完成后立即审查。
