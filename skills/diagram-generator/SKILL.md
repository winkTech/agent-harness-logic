---
name: diagram-generator
description: Generates architecture, database, and system diagrams using Mermaid syntax or Draw.io XML. Creates visual representations of system architecture, database schemas, component relationships, data flows, and standalone HTML exports. Supports both Mermaid (simple diagrams) and Draw.io (complex architecture with精细控制).
version: 1.5.0
model: sonnet
invoked_by: both
user_invocable: true
tools: [Read, Write, Glob, Grep, Bash]
best_practices:
  - Use Mermaid syntax for simple diagrams (flowcharts, sequence, class)
  - Use Draw.io for complex architecture diagrams requiring精细控制
  - Extract structure from code and documentation
  - Keep diagrams under 200 nodes
  - Generate both high-level and detailed views
error_handling: graceful
streaming: supported
templates: [architecture-diagram, database-diagram, component-diagram, sequence-diagram]
verified: true
lastVerifiedAt: 2026-03-15T00:00:00.000Z
source: builtin
trust_score: 100
provenance_sha: be44b78f364f1c89
---

<identity>
Diagram Generator — creates Mermaid diagrams, Draw.io XML files, and standalone HTML exports for architecture, schemas, flows, and all supported diagram types. Supports both Mermaid (simple, text-based) and Draw.io (complex, pixel-perfect control).
</identity>

## Diagram Types

| Type      | Keyword           | Best For                    |
| --------- | ----------------- | --------------------------- |
| Flowchart | `flowchart TB/LR` | Decision flows, processes   |
| Sequence  | `sequenceDiagram` | API interactions, protocols |
| Class     | `classDiagram`    | OOP structure, interfaces   |
| State     | `stateDiagram-v2` | Lifecycle, state machines   |
| ER        | `erDiagram`       | Database schemas            |
| Gantt     | `gantt`           | Project timelines           |
| Pie       | `pie`             | Distribution, composition   |
| Mindmap   | `mindmap`         | Hierarchical mind maps      |
| Timeline  | `timeline`        | Chronological events        |
| Git Graph | `gitGraph`        | Branch visualization        |
| Kanban    | `kanban`          | Task boards                 |
| Quadrant  | `quadrantChart`   | 2x2 matrix                  |

## Processing Limits

- **File chunk limit: 1000 files per diagram (HARD LIMIT)**
- Visual limit: ~200 nodes max per diagram
- Large codebases: split by subsystem/layer; generate overview first then details

## Standalone HTML Output Mode

**Trigger phrases:** "export as HTML", "standalone diagram", "interactive diagram"

Generate a self-contained HTML file with embedded Mermaid.js CDN, dark/light toggle button, and responsive CSS (max-width: 1200px):

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>TITLE</title>
    <script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script>
    <script>
      mermaid.initialize({ startOnLoad: true, theme: 'dark' });
    </script>
    <style>
      body {
        font-family: system-ui;
        max-width: 1200px;
        margin: 2rem auto;
        background: #1e1e2e;
        color: #cdd6f4;
      }
    </style>
  </head>
  <body>
    <h1>TITLE</h1>
    <button
      onclick="let d=!d;mermaid.initialize({startOnLoad:false,theme:d?'dark':'default'});document.querySelector('.mermaid').removeAttribute('data-processed');mermaid.run()"
    >
      Toggle Theme
    </button>
    <div class="mermaid">MERMAID_CONTENT</div>
  </body>
</html>
```

**Default:** dark mode (`background: #1e1e2e`, `color: #cdd6f4`)
**Output:** `.claude/context/artifacts/diagrams/{subject}-{YYYY-MM-DD}.html`

## Output Location

- Mermaid files: `.claude/context/artifacts/diagrams/{subject}-{type}-{YYYY-MM-DD}.mmd`
- HTML files: `.claude/context/artifacts/diagrams/{subject}-{YYYY-MM-DD}.html`

## Iron Laws

1. Mermaid syntax only — no ASCII art or PlantUML.
2. Never exceed 200 nodes per diagram.
3. Never write diagrams outside `.claude/context/artifacts/diagrams/`.
4. Label all non-obvious connections.
5. Enforce 1000-file hard limit — chunk large codebases.

## Mermaid Plugin Generation Pattern

Generate diagrams from code analysis using the Claude Code plugin pattern (ref: agentic-coding-school/mermaid-diagram-plugin):

### Step 1: Analyze Codebase Structure

```bash
# Identify components to diagram
pnpm search:code "class|interface|module|service|component" | head -50
```

### Step 2: Generate Mermaid Source

Use Claude to transform code analysis into diagram syntax. Always request a specific diagram type and scope:

```
"Generate a Mermaid flowchart TB of the authentication flow in src/auth/"
"Create an ER diagram for the database tables in prisma/schema.prisma"
"Make a sequence diagram for the API request lifecycle in src/api/"
```

### Step 3: Render Interactive HTML

For standalone shareable diagrams, use the full HTML template:

```javascript
// Plugin invocation pattern (from mermaid-diagram-plugin)
const mermaidContent = `
flowchart TB
  A[User Request] --> B{Auth Check}
  B -- Valid --> C[Route Handler]
  B -- Invalid --> D[401 Response]
  C --> E[Database Query]
  E --> F[Response]
`;

// Render to interactive HTML
const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>${title}</title>
    <script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script>
    <script>mermaid.initialize({ startOnLoad: true, theme: 'dark' });</script>
    <style>
      body { font-family: system-ui; max-width: 1200px; margin: 2rem auto;
             background: #1e1e2e; color: #cdd6f4; }
      .controls { margin-bottom: 1rem; }
      button { padding: 0.5rem 1rem; margin-right: 0.5rem; cursor: pointer; }
    </style>
  </head>
  <body>
    <h1>${title}</h1>
    <div class="controls">
      <button onclick="toggleTheme()">Toggle Theme</button>
      <button onclick="downloadSVG()">Download SVG</button>
    </div>
    <div class="mermaid">${mermaidContent}</div>
    <script>
      let dark = true;
      function toggleTheme() {
        dark = !dark;
        mermaid.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'default' });
        document.querySelector('.mermaid').removeAttribute('data-processed');
        mermaid.run();
      }
      function downloadSVG() {
        const svg = document.querySelector('.mermaid svg');
        if (!svg) return;
        const blob = new Blob([svg.outerHTML], { type: 'image/svg+xml' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
        a.download = '${title.replace(/\s+/g, '-')}.svg'; a.click();
      }
    </script>
  </body>
</html>`;
```

### Step 4: Save Output

```bash
# Save interactive HTML to standard location
# .claude/context/artifacts/diagrams/{subject}-{YYYY-MM-DD}.html
```

### Plugin Invocation from Agent

When an agent needs a diagram as part of a workflow:

```javascript
// Invoke diagram-generator skill, then request specific type
Skill({ skill: 'diagram-generator' });

// Then describe what to diagram with context
// "Create a class diagram for src/lib/routing/ — show all classes and their relationships"
```

## Local References

| 主题 | 文件 | 说明 |
|------|------|------|
| 绘图规则 | `references/draw-rule.md` | Drawio/Visio绘图约束、布局、字体颜色规范 |
| Draw.io核心 | `references/drawio-core.md` | Draw.io XML结构、形状、连接器、导出命令 |
| 图表类型预设 | `references/diagram-types.md` | ERD、UML、序列、架构、ML/DL、流程图预设 |
| 样式预设 | `references/style-presets.md` | 用户样式预设管理 |
| 样式提取 | `references/style-extraction.md` | 从文件提取样式预设 |
| 故障排除 | `references/troubleshooting.md` | Draw.io导出失败、渲染问题修复 |
| PNG修复脚本 | `scripts/repair_png.py` | 修复Draw.io截断的IEND块 |
| URL编码脚本 | `scripts/encode_drawio_url.py` | 浏览器回退URL生成 |

## When to invoke

`Skill({ skill: 'diagram-generator' })` for architecture diagrams, HTML exports, mindmaps, timelines, git visualizations, kanban boards, and quadrant charts.
