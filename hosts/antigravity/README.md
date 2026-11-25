# Logical Paradox Harness — Antigravity Host Adapter

`hosts/antigravity/` 是 Antigravity 宿主插件的**唯一源码本体（Single Source of Truth）**，支持两种部署形态：

- **方案 A（默认 · 本机瘦链接开发态）**：`npm run antigravity:connect` 将桥接脚本与渲染后的 `skills/`、`agents/`、`rules/AGENTS.md`、`hooks.json`、`mcp_config.json`、`plugin.json` 投放至 `~/.gemini/config/plugins/logical-paradox/`，并通过 `.source-root.json` 指向本仓库的 `core/engine/`（引擎改动免重装），同时默认施加 OS 级只读保护防止运行期篡改。
- **便携分发包模式（`--portable` / `dist/antigravity-plugin/`）**：自包含 `core/engine/` 与 `core/rules/`，在 `mcp_config.json` 中使用 `${PLUGIN_ROOT}` 与 `${PLUGIN_DATA}` 相对占位符，零本机路径耦合，可直接打包分发。

## 常用命令

```powershell
# 1. 连接 / 同步至本机 Antigravity 插件目录（方案 A，自动解封→同步→重封固只读 ACL）
#    通用开发者可追加 --packs core 或 --packs core,office（不含 FPGA 技能/Agent/MATLAB MCP）
npm.cmd run antigravity:connect -- --refresh
npm.cmd run connect -- antigravity --packs core --refresh

# 2. 部署自包含便携独立包（零本机路径耦合，可打包分发给他人）
npm.cmd run connect -- antigravity --portable --packs core

# 3. 只读零漂移检查（核对本机插件目录与仓库源码/技能/规则/清单）
npm.cmd run antigravity:connect -- --check

# 4. 构建 / 校验便携独立分发包（dist/antigravity-plugin/）
node core/engine/scripts/sync-plugin-dist.cjs
node core/engine/scripts/sync-plugin-dist.cjs --check

# 5. 全量离线回归（49 项冻结基线 + 38 类对抗探针 + 5 事件冒烟 + 源仓契约）
npm.cmd run antigravity:test
```

## 脚本执行安全边界

Shell Hook 依据工具参数、工作目录和可识别命令执行拦截或确认；图灵完备外部脚本（`node helper.js` / `python helper.py`）对插件目录的写防护由安装期施加的 **OS 只读 ACL**（`core/engine/scripts/lib/plugin-acl.cjs`）兜底，运行态数据严格隔离在 `~/.logical-paradox/var/`（`${PLUGIN_DATA}`）。
