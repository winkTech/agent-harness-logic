---
name: drawing-rules
description: "绘图规范 — Draw.io/Mermaid 工具选择和核心规则"
priority: L2
trigger: "绘图 / 画图 / 架构图 / 流程图 / 框图 / drawio / diagram"
skip: "纯文本 / 代码编写 / RTL 编写 / 仿真调试"
---

# 绘图规则

> L2 优先级：涉及绘图/画图工作时自动加载。

## 工具选择

| 工具 | 适用场景 | 输出 |
|:-----|:---------|:-----|
| **Draw.io** | 复杂架构图（>10 节点）、精细控制 | `.drawio.png`（含可编辑 XML） |
| **Mermaid** | 简单流程图、时序图 | 嵌入 Markdown |

## Draw.io 核心规则

1. **布局**：坐标对齐 10 的倍数，正交走线，间距 ≥ 30px
2. **连线**：`edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;html=1;`
3. **文本**：`html=1`，多行用 `&#xa;`，框高容纳全部文字
4. **颜色**：同图 ≤ 5 色，背景亮度 ≥ 200，文字亮度 ≤ 80

### 导出命令

```bash
draw.io -x -f png -e -s 2 -o diagram.drawio.png input.drawio
# Windows: "C:\Program Files\draw.io\draw.io.exe" -x -f png -e -s 2 -o diagram.drawio.png input.drawio
# -e 后必须运行修复: python3 skills/presentation/scripts/repair_png.py diagram.drawio.png
```

## 详细参考

- XML 骨架/形状/连线/颜色表 → `skills/presentation/references/drawio-core.md`
- 样式预设 → `skills/presentation/references/style-presets.md`
- 图表类型 → `skills/presentation/references/diagram-types.md`
- 故障排除 → `skills/presentation/references/troubleshooting.md`
