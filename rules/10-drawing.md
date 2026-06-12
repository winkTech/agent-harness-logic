---
name: drawing-rules
description: "绘图规范 — Draw.io/Mermaid 框图、架构图、流程图、时序图绘制规范"
priority: L2
trigger: "绘图 / 画图 / 架构图 / 流程图 / 框图 / 时序图 / 示意图 / drawio / diagram / 画个"
skip: "纯文本 / 代码编写 / RTL 编写 / 仿真调试 / 文档阅读"
---

# 绘图规则

> L2 优先级：涉及绘图/画图工作时自动加载。

## 工具选择

| 工具 | 适用场景 | 说明 |
|:----|:---------|:------|
| **Draw.io** | 复杂架构图、精细控制的大型图 | 输出 `.drawio.png`（含可编辑 XML） |
| **Mermaid** | 简单流程图、时序图 | 快速生成，嵌入 Markdown |

复杂图（>10 节点）用 Draw.io，简单图用 Mermaid。

## Draw.io 核心规则

### XML 骨架

```xml
<?xml version="1.0" encoding="UTF-8"?>
<mxfile host="drawio" version="26.0.0">
  <diagram name="Page-1">
    <mxGraphModel>
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        <!-- 形状从 id="2" 开始 -->
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
```

### 形状类型

| 样式 | 用途 |
|:-----|:------|
| `rounded=1;` | 圆角矩形 — 服务/模块 |
| `ellipse;` | 圆形 — 开始/结束 |
| `rhombus;` | 菱形 — 决策 |
| `shape=cylinder3;` | 圆柱体 — 数据库 |
| `swimlane;` | 带标题的分组容器 |

### 容器（分组）

- 子元素设置 `parent="容器id"`，坐标**相对于容器**
- 容器样式加 `container=1;pointerEvents=0;` 防止干扰连线
- Swimlane 样式：`swimlane;startSize=30;`

### 连线

每条边必须包含完整 `<mxGeometry relative="1" as="geometry" />` 子元素：

```xml
<mxCell id="10" value="" style="edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;html=1;" edge="1" parent="1" source="2" target="3">
  <mxGeometry relative="1" as="geometry" />
</mxCell>
```

- 始终包含 `rounded=1;orthogonalLoop=1;jettySize=auto`
- 多连接时固定 `exitX/exitY/entryX/entryY` 分布各侧
- 如需路径点：`<Array as="points"><mxPoint x="500" y="50"/></Array>`

### 文本与间距约束

- 矩形框左右内边距 ≥ 文本高度 × 2，上下 ≥ 文本高度 × 0.5
- 同层级相邻框间距 ≥ 30px
- 分组框与内部子框间距 ≥ 15px
- 文字使用 `html=1`，多行用 `&#xa;`（不是 `\n`）

### 布局

- 所有坐标/尺寸对齐到 **10 的倍数**
- 正交走线，禁止斜线
- 连线转弯点距框边界 ≥ 10px
- 路由走廊约 80px，不让形状阻塞连线路径

### 颜色规范

| 用途 | 填充色 | 边框色 |
|:-----|:-------|:-------|
| 服务/模块 | `#dae8fc` | `#6c8ebf` |
| 成功/数据库 | `#d5e8d4` | `#82b366` |
| 决策/队列 | `#fff2cc` | `#d6b656` |
| API/网关 | `#ffe6cc` | `#d79b00` |
| 错误/警报 | `#f8cecc` | `#b85450` |
| 外部/中性 | `#f5f5f5` | `#666666` |

- 背景色亮度 ≥ 200，文字色亮度 ≤ 80（RGB 总和）
- 同一张图内颜色 ≤ 5 种（不含黑白灰）

### 导出命令

```bash
# 预览（PNG，不带 -e）
draw.io -x -f png -s 2 -o diagram.png input.drawio

# 最终（PNG 嵌入 XML，双扩展名）
draw.io -x -f png -e -s 2 -o diagram.drawio.png input.drawio

# 修复截断的 IEND 块（-e PNG 后必须运行）
python3 skills/presentation/scripts/repair_png.py diagram.drawio.png

# SVG
draw.io -x -f svg -e -o diagram.svg input.drawio

# Windows 路径
"C:\Program Files\draw.io\draw.io.exe" -x -f png -e -s 2 -o diagram.drawio.png input.drawio
```

### 生成前自查清单

- [ ] 所有框高度是否容纳全部文字（含标题+正文）？
- [ ] 任意两个框间距 ≥ 30px？
- [ ] 是否有连线穿过框的标题区域？
- [ ] 同行/同列框是否对齐？
- [ ] 同层字体大小是否统一？
- [ ] 连线是否正交走线（非斜线）？
- [ ] 版面是否尽量紧凑？

## 详细参考

- 完整 Draw.io XML 参考：`skills/presentation/references/drawio-core.md`
- 绘图样式与排版规范：`skills/presentation/references/draw-rule.md`
- 样式预设：`skills/presentation/references/style-presets.md`
- 故障排除：`skills/presentation/references/troubleshooting.md`
- 图表类型预设：`skills/presentation/references/diagram-types.md`
