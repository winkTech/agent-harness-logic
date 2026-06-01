# MCP 配置完善计划

## Context

当前项目中有 2 个 MCP 配置文件：
- `.mcp.json`（项目根目录）- 仅包含 telegram-relay
- `.claude/.mcp.json` - 包含 8 个服务器，但部分未连接

已连接的服务器（正常工作）：
- memory（知识图谱）
- sequential-thinking（问题求解）
- markitdown（文档转换）
- exa（网络搜索，插件内置）
- context7（文档查询，插件内置）
- playwright（浏览器自动化，插件内置）

未连接的服务器（需要修复）：
- filesystem（文件系统访问）
- git（Git 操作）
- github（GitHub API）
- sqlite（SQLite 数据库）
- telegram-relay（Telegram 集成）

## 修改文件

### 1. `.claude/.mcp.json`（主要配置文件）

修复未连接的服务器，优化已连接的服务器配置。

### 2. `.env.example`（环境变量）

添加必要的 API 密钥占位符（如 GITHUB_TOKEN）。

## 服务器配置详情

### 已连接服务器（保持并优化）

| 服务器 | 当前状态 | 优化内容 |
|--------|----------|----------|
| memory | ✅ 正常 | 无需修改 |
| sequential-thinking | ✅ 正常 | 无需修改 |
| markitdown | ✅ 正常 | 无需修改 |

### 未连接服务器（需要修复）

| 服务器 | 问题 | 修复方案 |
|--------|------|----------|
| filesystem | 路径硬编码为 `C:\dev\projects\agent-studio` | 更新为当前项目路径 |
| git | 路径硬编码为 `C:\dev\projects\agent-studio` | 更新为当前项目路径 |
| github | 缺少认证配置 | 添加 GITHUB_TOKEN 环境变量 |
| sqlite | 数据库路径可能不存在 | 确保目录存在 |
| telegram-relay | 脚本路径可能不正确 | 验证脚本存在 |

### 插件服务器（无需配置）

- exa：由 everything-claude-code 插件管理
- context7：由 everything-claude-code 插件管理
- playwright：由 everything-claude-code 插件管理

## 实施步骤

1. 更新 `.claude/.mcp.json` 中的 filesystem 和 git 服务器路径
2. 为 github 服务器添加 GITHUB_TOKEN 环境变量
3. 验证 telegram-relay 脚本路径
4. 确保 sqlite 数据库目录存在
5. 更新 `.env.example` 添加必要的环境变量占位符

## 验证方法

1. 重启 Claude Code 会话
2. 检查 MCP 服务器连接状态
3. 测试各服务器功能：
   - filesystem：读取文件
   - git：执行 git 命令
   - github：调用 GitHub API
   - sqlite：执行 SQL 查询
   - telegram-relay：发送测试消息
