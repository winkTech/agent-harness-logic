#!/bin/bash
# 开源准备脚本
# 用途：准备开源项目，脱敏敏感信息

OUTPUT_DIR="${HOME}/claude-agent-open-source"
SOURCE_DIR="${HOME}/.claude"

echo "=== 开源准备 ==="
echo ""

# 1. 创建输出目录
echo "📁 1. 创建输出目录..."
mkdir -p "$OUTPUT_DIR"
echo "  ✅ 输出目录: $OUTPUT_DIR"
echo ""

# 2. 复制通用文件
echo "📋 2. 复制通用文件..."
# 复制 CLAUDE.md（需要脱敏）
cp "$SOURCE_DIR/CLAUDE.md" "$OUTPUT_DIR/CLAUDE.md"
echo "  ✅ CLAUDE.md"

# 复制 references（需要脱敏）
cp -r "$SOURCE_DIR/references" "$OUTPUT_DIR/"
echo "  ✅ references/"

# 复制 scripts
cp -r "$SOURCE_DIR/scripts" "$OUTPUT_DIR/"
echo "  ✅ scripts/"

# 复制 knowledge 框架
mkdir -p "$OUTPUT_DIR/knowledge"
cp "$SOURCE_DIR/knowledge/INDEX.md" "$OUTPUT_DIR/knowledge/" 2>/dev/null
cp "$SOURCE_DIR/knowledge/data_structure.md" "$OUTPUT_DIR/knowledge/" 2>/dev/null
echo "  ✅ knowledge/"
echo ""

# 3. 脱敏处理
echo "🔒 3. 脱敏处理..."
# 脱敏 settings.json
cat > "$OUTPUT_DIR/settings.json.example" << 'EOF'
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "your-api-token-here",
    "ANTHROPIC_BASE_URL": "https://api.anthropic.com"
  },
  "permissions": {
    "deny": [],
    "ask": [],
    "defaultMode": "auto"
  },
  "enabledPlugins": {
    "everything-claude-code@everything-claude-code": true,
    "superpowers@claude-plugins-official": true
  }
}
EOF
echo "  ✅ settings.json.example"

# 脱敏 CLAUDE.md 中的个人路径
sed -i 's|${HOME}/.claude|~/.claude|g' "$OUTPUT_DIR/CLAUDE.md"
echo "  ✅ CLAUDE.md 路径脱敏"
echo ""

# 4. 创建 .gitignore
echo "📝 4. 创建 .gitignore..."
cat > "$OUTPUT_DIR/.gitignore" << 'EOF'
# 个人配置
settings.json
*.local

# 记忆文件
memory/
*.memory

# 个人知识库
knowledge/primary/
knowledge/source/

# 插件缓存
plugins/cache/

# 临时文件
*.tmp
*.log
.DS_Store
EOF
echo "  ✅ .gitignore"
echo ""

# 5. 创建 README
echo "📖 5. 创建 README..."
cat > "$OUTPUT_DIR/README.md" << 'EOF'
# Claude Agent Configuration

基于 Claude Code 的个人 Agent 配置，支持 FPGA 开发、Python、MATLAB 等领域。

## 功能特性

- 模块化配置，按需加载
- 知识库集成，智能检索
- 记忆系统，经验积累
- 工具脚本，自动化管理

## 快速开始

1. 克隆仓库
2. 复制配置文件
3. 配置 API Token
4. 开始使用

## 目录结构

```
├── CLAUDE.md              # 核心配置
├── references/            # 参考文档
├── scripts/               # 工具脚本
├── knowledge/             # 知识库框架
└── settings.json.example  # 配置示例
```

## 许可证

MIT License
EOF
echo "  ✅ README.md"
echo ""

echo "=== 准备完成 ==="
echo "输出目录: $OUTPUT_DIR"
echo ""
echo "下一步:"
echo "1. 检查 $OUTPUT_DIR 中的文件"
echo "2. 确认脱敏正确"
echo "3. 初始化 Git 仓库"
echo "4. 推送到 GitHub"
