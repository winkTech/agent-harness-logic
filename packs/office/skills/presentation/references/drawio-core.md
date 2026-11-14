# Draw.io 核心参考

> 来源：[drawio-skill](https://github.com/Agents365-ai/drawio-skill) v1.5.2

## 概述

生成 `.drawio` XML 文件并使用 draw.io 桌面应用 CLI 导出为 PNG/SVG/PDF/JPG。

**支持格式：** PNG, SVG, PDF, JPG — 无需浏览器自动化。

PNG、SVG 和 PDF 导出支持 `--embed-diagram` (`-e`) — 导出文件包含完整图表 XML，在 draw.io 中打开可恢复可编辑图表。使用双扩展名 (`name.drawio.png`) 表示嵌入 XML。

## 前置条件

draw.io 桌面应用必须已安装且 CLI 可访问：

```bash
# Windows
"C:\Program Files\draw.io\draw.io.exe" --version

# macOS (Homebrew)
brew install --cask drawio
draw.io --version

# Linux
draw.io --version
```

安装 draw.io 桌面应用：
- Windows: 从 https://github.com/jgraph/drawio-desktop/releases 下载安装程序
- macOS: `brew install --cask drawio` 或从上述链接下载
- Linux: 下载 `.deb`/`.rpm` — **不要使用 snap**（AppArmor 沙箱拒绝服务器上的 secrets/keyring，导致崩溃）

## Draw.io XML 结构

### 文件骨架

```xml
<?xml version="1.0" encoding="UTF-8"?>
<mxfile host="drawio" version="26.0.0">
  <diagram name="Page-1">
    <mxGraphModel>
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        <!-- 用户形状从 id="2" 开始 -->
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
```

**规则：**
- `id="0"` 和 `id="1"` 是必需的根单元格 — 永远不要省略
- 用户形状从 `id="2"` 开始，按顺序递增
- 所有形状都有 `parent="1"`（如果在容器内 — 使用容器的 id）
- 所有文本在样式中使用 `html=1` 以正确渲染
- **永远不要在 XML 注释中使用 `--`** — 这违反 XML 规范并导致解析错误
- 转义属性值中的特殊字符：`&amp;`, `&lt;`, `&gt;`, `&quot;`
- **标签中的多行文本：** 在 `value` 属性中使用 `&#xa` 表示换行（不是字面 `\n`）。示例：`value="Line 1&#xa;Line 2"`

### 形状类型（顶点）

| 样式关键字 | 用途 |
|-----------|------|
| `rounded=0` | 普通矩形（默认） |
| `rounded=1` | 圆角矩形 — 服务、模块 |
| `ellipse;` | 圆形/椭圆形 — 开始/结束、数据库 |
| `rhombus;` | 菱形 — 决策点 |
| `shape=mxgraph.aws4.resourceIcon;` | AWS 图标 |
| `shape=cylinder3;` | 圆柱体 — 数据库 |
| `swimlane;` | 带标题栏的分组/容器 |

### 必需属性

```xml
<!-- 矩形/圆角框 -->
<mxCell id="2" value="Label" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">
  <mxGeometry x="100" y="100" width="160" height="60" as="geometry" />
</mxCell>

<!-- 圆柱体（数据库） -->
<mxCell id="3" value="DB" style="shape=cylinder3;whiteSpace=wrap;html=1;fillColor=#f5f5f5;strokeColor=#666666;fontColor=#333333;" vertex="1" parent="1">
  <mxGeometry x="350" y="100" width="120" height="80" as="geometry" />
</mxCell>

<!-- 菱形（决策） -->
<mxCell id="4" value="Check?" style="rhombus;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;" vertex="1" parent="1">
  <mxGeometry x="100" y="220" width="160" height="80" as="geometry" />
</mxCell>
```

### 容器和分组

对于包含嵌套元素的架构图，使用 draw.io 的父子包含 — **不要**只是将形状放在较大形状的顶部。

| 类型 | 样式 | 何时使用 |
|------|------|----------|
| **Group**（不可见） | `group;pointerEvents=0;` | 不需要可见边框，容器没有连接 |
| **Swimlane**（带标题） | `swimlane;startSize=30;` | 容器需要可见标题栏，或容器本身有连接 |
| **Custom container** | 在任何形状上添加 `container=1;pointerEvents=0;` | 任何作为容器但没有自身连接的形状 |

**关键规则：**
- 在不应捕获子元素之间连接的容器样式中添加 `pointerEvents=0;`
- 子元素设置 `parent="containerId"` 并使用**相对于容器**的坐标

```xml
<!-- Swimlane 容器 -->
<mxCell id="svc1" value="User Service" style="swimlane;startSize=30;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">
  <mxGeometry x="100" y="100" width="300" height="200" as="geometry"/>
</mxCell>
<!-- 容器内的子元素 — 坐标相对于父元素 -->
<mxCell id="api1" value="REST API" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="svc1">
  <mxGeometry x="20" y="40" width="120" height="60" as="geometry"/>
</mxCell>
<mxCell id="db1" value="Database" style="shape=cylinder3;whiteSpace=wrap;html=1;" vertex="1" parent="svc1">
  <mxGeometry x="160" y="40" width="120" height="60" as="geometry"/>
</mxCell>
```

### 连接器（边）

**关键：** 每个边 `mxCell` 必须包含 `<mxGeometry relative="1" as="geometry" />` 子元素。自闭合边单元格（`<mxCell ... edge="1" ... />`）**无效**且不会渲染。始终使用展开形式。

```xml
<!-- 有向箭头 — 始终包含 rounded, orthogonalLoop, jettySize 以实现清晰路由 -->
<mxCell id="10" value="" style="edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;html=1;" edge="1" parent="1" source="2" target="3">
  <mxGeometry relative="1" as="geometry" />
</mxCell>

<!-- 带标签 + 显式入口/出口点以控制方向的箭头 -->
<mxCell id="11" value="HTTP/REST" style="edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;html=1;exitX=0.5;exitY=1;exitDx=0;exitDy=0;entryX=0.5;entryY=0;entryDx=0;entryDy=0;" edge="1" parent="1" source="2" target="4">
  <mxGeometry relative="1" as="geometry" />
</mxCell>

<!-- 带路径点的箭头 — 当边必须绕过其他形状时使用 -->
<mxCell id="12" value="" style="edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;html=1;" edge="1" parent="1" source="3" target="5">
  <mxGeometry relative="1" as="geometry">
    <Array as="points">
      <mxPoint x="500" y="50" />
    </Array>
  </mxGeometry>
</mxCell>
```

**边样式规则：**
- **动画连接器：** 在任何边样式中添加 `flowAnimation=1;` 以显示沿箭头移动的点动画。适用于 SVG 导出和 draw.io 桌面 — 非常适合数据流和管道图。
- **始终**包含 `rounded=1;orthogonalLoop=1;jettySize=auto` — 这些启用智能路由以避免重叠
- 当节点有 2+ 个连接时，在每条边上固定 `exitX/exitY/entryX/entryY` — 在形状周长上分布线条
- 当边必须绕过中间形状时添加 `<Array as="points">` 路径点
- **为箭头留出空间：** 最后一个弯曲和目标形状之间的最终直线段必须 ≥20px 长。如果太短，箭头会与弯曲重叠且看起来断裂。

### 在形状上分布连接

当多条边连接到同一形状时，分配不同的入口/出口点以防止堆叠：

| 位置 | exitX/entryX | exitY/entryY | 何时使用 |
|------|-------------|-------------|----------|
| 顶部中心 | 0.5 | 0 | 连接到上方节点 |
| 左上 | 0.25 | 0 | 从顶部的第2个连接 |
| 右上 | 0.75 | 0 | 从顶部的第3个连接 |
| 右侧中心 | 1 | 0.5 | 连接到右侧节点 |
| 底部中心 | 0.5 | 1 | 连接到下方节点 |
| 左侧中心 | 0 | 0.5 | 连接到左侧节点 |

**规则：** 如果形状在一侧有 N 个连接，均匀间隔（例如，底部有 3 个连接 → exitX = 0.25, 0.5, 0.75）

### 调色板（fillColor / strokeColor）

*仅在没有激活预设时使用。*

| 颜色名称 | fillColor | strokeColor | 用途 |
|----------|-----------|-------------|------|
| 蓝色 | `#dae8fc` | `#6c8ebf` | 服务、客户端 |
| 绿色 | `#d5e8d4` | `#82b366` | 成功、数据库 |
| 黄色 | `#fff2cc` | `#d6b656` | 队列、决策 |
| 橙色 | `#ffe6cc` | `#d79b00` | 网关、API |
| 红色/粉色 | `#f8cecc` | `#b85450` | 错误、警报 |
| 灰色 | `#f5f5f5` | `#666666` | 外部/中性 |
| 紫色 | `#e1d5e7` | `#9673a6` | 安全、认证 |

### 布局技巧

**间距 — 随复杂度缩放：**

| 图表复杂度 | 节点数 | 水平间距 | 垂直间距 |
|-----------|-------|----------|----------|
| 简单 | ≤5 | 200px | 150px |
| 中等 | 6–10 | 280px | 200px |
| 复杂 | >10 | 350px | 250px |

**路由走廊：** 在形状行/列之间，留出约 80px 的额外空走廊，边可以在其中路由而不穿过形状。永远不要将形状放在边需要穿过的间隙中。

**网格对齐：** 将所有 `x`, `y`, `width`, `height` 值对齐到 **10 的倍数** — 这确保形状在 draw.io 的默认网格上清晰对齐，并使手动编辑更容易。

**一般规则：**
- 在分配 x/y 坐标之前规划网格 — 先在纸上/心中草绘节点位置
- 将相关节点分组在同一水平或垂直带中
- 使用 `swimlane` 单元格进行带可见边框的逻辑分组
- 将高度连接的"枢纽"节点放置在中心，使边向外辐射而不是交叉
- 要强制垂直直线连接，在边上显式固定入口/出口点：
  `exitX=0.5;exitY=1;exitDx=0;exitDy=0;entryX=0.5;entryY=0;entryDx=0;entryDy=0`
- 始终将子节点居中对齐在其父节点下方（相同的中心 x）以避免对角线路由
- **事件总线模式：** 将 Kafka/总线节点放在**服务行的中心**，而不是下方 — 两侧的服务可以用短水平箭头到达它（左侧 `exitX=1`，右侧 `exitX=0`），消除所有线条交叉

**避免边-形状重叠：**
- 在最终确定坐标之前，心理追踪每条边的路径 — 如果它必须穿过无关形状，请移动形状或添加路径点
- 对于树/层次布局：将节点分配到层（行），仅在相邻层之间连接以最小化交叉
- 对于星/枢纽布局：将枢纽放在中心，卫星围绕它 — 边保持短且径向
- 当边必须跨多行/列时，沿外走廊路由，而不是穿过图表中间

## 导出

### 命令

有两种导出模式：

- **预览/自检**（工作流步骤 4）— 不使用 `-e`。输出 `diagram.png`。视觉自检必需；使用 `-e` 会导致视觉 API 返回 400 "Could not process image" 错误。
- **最终/可交付**（步骤 7）— 传递 `-e`。输出 `diagram.drawio.png`。嵌入的 XML 使文件在 draw.io 中保持可编辑。

```bash
# 预览 PNG（在步骤 4 中使用，自检前）— 不带 -e
draw.io -x -f png -s 2 -o diagram.png input.drawio

# 最终 PNG（步骤 7，用户批准后）— 带 -e，双扩展名
draw.io -x -f png -e -s 2 -o diagram.drawio.png input.drawio

# Windows
"C:\Program Files\draw.io\draw.io.exe" -x -f png -e -s 2 -o diagram.drawio.png input.drawio

# SVG 导出（最终 — -e 是安全的；SVG 是文本）
draw.io -x -f svg -e -o diagram.svg input.drawio

# PDF 导出（最终）
draw.io -x -f pdf -e -o diagram.pdf input.drawio

# 自定义输出目录 — 如果缺失则创建，然后在那里导出
mkdir -p ./artifacts && draw.io -x -f png -e -s 2 -o ./artifacts/diagram.drawio.png input.drawio
```

### PNG 导出后修复（`-e` PNG 导出后必需）

draw.io CLI 在发出 `-e` PNG 时会截断 IEND 块 — 文件以 4 字节 IEND 长度字段结尾，但 `IEND` 类型 + CRC（8 字节）缺失。结果：视觉 API 返回 400 "Could not process image"，严格的 PNG 解码器报错。SVG/PDF 不受影响。

在每次 `-e` PNG 导出后立即运行：

```bash
python3 <skill-dir>/scripts/repair_png.py diagram.drawio.png
```

**关键标志：**
- `-x` — 导出模式（必需）
- `-f` — 格式：`png`, `svg`, `pdf`, `jpg`
- `-e` — 在输出中嵌入图表 XML（PNG, SVG, PDF）— 导出文件在 draw.io 中保持可编辑。**在步骤 5 自检使用的预览 PNG 中跳过** — `-e` PNG 有截断的 IEND 块，视觉 API 会拒绝。对于最终 PNG 导出，保留 `-e` 并运行 `scripts/repair_png.py`。
- `-s` — 缩放：`1`, `2`, `3`（PNG 推荐 2）
- `-o` — 输出文件路径；接受任何目录 — 首先 `mkdir -p` 目标目录。嵌入时使用 `.drawio.png` 双扩展名。
- `-b` — 图表周围的边框宽度（默认：0，推荐 10）
- `-t` — 透明背景（仅 PNG）
- `--page-index 0` — 导出特定页面（默认：所有）

### 浏览器回退（无需 CLI）

当 draw.io 桌面 CLI 不可用时，生成客户端查看器 URL：

```bash
python3 <skill-dir>/scripts/encode_drawio_url.py input.drawio
```

打印 `https://viewer.diagrams.net/...` URL，图表 XML 经过 deflate 压缩和 base64 编码嵌入 URL 片段中。片段（`#` 之后）永远不会发送到服务器，因此没有任何内容被上传 — 图表在客户端打开以供查看和编辑。

### 回退链

当工具不可用时，优雅降级：

| 场景 | 行为 |
|------|------|
| draw.io CLI 缺失，Python 可用 | 使用浏览器回退（diagrams.net URL） |
| draw.io CLI 缺失，Python 缺失 | 仅生成 `.drawio` XML；指示用户在 draw.io 桌面或 diagrams.net 中手动打开 |
| 视觉不可用于自检 | 跳过自检（步骤 5）；直接向用户显示导出的 PNG |
| 导出失败（Chromium/显示问题） | 在 Linux 上，使用 `xvfb-run -a` 重试；如果仍然失败，提供 `.drawio` XML 并建议手动导出 |

## 详细参考

| 主题 | 文件 | 说明 |
|------|------|------|
| 图表类型预设 | `references/diagram-types.md` | ERD、UML、序列、架构、ML/DL、流程图预设 |
| 样式预设 | `references/style-presets.md` | 用户样式预设管理 |
| 样式提取 | `references/style-extraction.md` | 从文件提取样式预设 |
| 故障排除 | `references/troubleshooting.md` | 导出失败、渲染问题修复 |
| PNG 修复脚本 | `scripts/repair_png.py` | 修复 draw.io 截断的 IEND 块 |
| URL 编码脚本 | `scripts/encode_drawio_url.py` | 浏览器回退 URL 生成 |
