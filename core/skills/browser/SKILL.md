---
name: browser
description: 浏览器自动化 — Agent 驱动的网页交互（导航/填表/截图/数据提取）+ 用户实时浏览器接入（登录态/DevTools/渲染结果）
version: 1.0.0
model: sonnet
invoked_by: both
user_invocable: true
tools: [Bash]
hidden: true
---

# Browser

浏览器交互统一入口。两种模式：

| 模式 | 场景 |
|:----|:------|
| **Agent 驱动** | 自动化导航、填表、截图、数据抓取、测试 |
| **用户实时浏览器** | 需登录态/CMS/本地应用/DevTools 检查的页面 |

## Agent 驱动模式

通过 `agent-browser:*` CLI 操作网页：

```bash
# 导航
agent-browser goto "https://example.com"

# 截图
agent-browser screenshot

# 填表
agent-browser type "#username" "user"
agent-browser click "#submit"

# 提取数据
agent-browser extract ".result-text"
```

**适用**: Web 自动化测试、数据抓取、QA、Electron 应用（VS Code/Slack/Figma）

## 用户实时浏览器模式

需要用户已登录状态或特定渲染结果的场景：

- 已登录的仪表盘、CMS 后台
- 本地开发环境 localhost
- 文件上传/下载
- Shadow DOM / iframe 检查
- 反爬虫/授权墙/限流检测

**选择原则**: 从"需要什么证据"出发，而非从"想用什么工具"出发。

| 需要 | 选择 |
|:----|:-----|
| 页面静态内容 | WebFetch |
| 需要渲染结果 | 浏览器模式 |
| 需要登录态 | 用户实时浏览器 |
| 需要自动化 | Agent 驱动模式 |
