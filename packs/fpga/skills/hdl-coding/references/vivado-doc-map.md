# Vivado 文档导航（UG 地图）

> **这本管"去哪查"，不管"怎么写"。** 语言级怎么写看 `vivado-synthesis-ug901.md`，
> 方法学看 `ug949-rtl-methodology.md`，命令怎么跑看 `vivado-tool-flow.md`。
> 本文解决的是另一个问题：Vivado 文档不是一本手册，而是按设计流程拆成的几十本 UG，
> 不知道哪本管哪件事就会在错误的文档里空转。

---

## §0 版本锚定 —— 读文档前必须先做的一步

**[MUST] 先查本机装的是哪一版，再去 docs.amd.com 把文档切到同一版。**

查版本不要靠记忆或猜，跑探测器：

```bash
node engine/scripts/eda-detect.cjs --json
```

它会读真实可执行文件报告 `vivado` / `xvlog` / `xelab` / `xsim` 的版本；同时装了多版时
按新到旧列出，但**实际生效的以 PATH 解析为准**：

```bash
which -a vivado xvlog     # Linux / Git Bash
where vivado & where xvlog # Windows cmd
```

docs.amd.com **默认显示最新发行版**，而本机通常落后若干个版本。这不是洁癖，跨版本会
实际踩到的坑：

- **TCL 命令不存在** —— 新版新增的 `report_*` 子命令、`-flag` 在旧版上直接报
  `invalid option`，脚本当场挂掉；
- **综合属性无效** —— 属性名写错或该版本不支持时，Vivado 往往只 warning 甚至静默忽略
  （见 `ug949-rtl-methodology.md` §属性纪律），你以为生效了其实没有；
- **器件根本不支持** —— 新发行版才加入的器件系列，旧版里没有对应 part，
  `-part` 参数直接失败。

切版本的位置：docs.amd.com 页面右上角的版本下拉框。**收藏链接前先确认 URL 里带的是
你要的版本**，否则下次打开又跳回最新版。

> 多版本并存时（常见于要维护历史工程），PATH 只会指向其中一个。要用另一版必须显式调用
> 它自己 `bin/` 下的可执行文件，别指望 PATH 会切过去。

---

## §1 三个入口

| 入口 | 地址 / 位置 | 适合 |
|:-----|:-----------|:-----|
| **AMD Technical Information Portal** | https://docs.amd.com | 在线搜索、浏览全部文档；**能切版本**，日常首选 |
| **DocNav**（本地离线） | Vivado IDE → Help → Documentation and Tutorials；或开始菜单 Xilinx Design Tools → DocNav；Linux 命令行 `docnav` | 离线过滤、搜文档/视频/支持资源。自身说明是 **UG968** |
| **Vivado Developer Hub** | https://www.amd.com/en/developer/resources/vivado.html | 版本下载、发布信息、教程入口 |

**DocNav 的 Design Hubs 标签页**把文档按*设计任务*重新组织了一遍——不知道该查哪本 UG
时，从这里按任务找比按编号找快。

---

## §2 按流程阶段查 UG

标 ✅ 的表示 **harness 已经把该 UG 的要点提炼成本地文件**，先读本地的，不够再上网。

| 阶段 | 文档 | 本地已提炼 |
|:-----|:-----|:-----------|
| 入门 / 安装 | UG910 Getting Started | — |
| 流程概览 | UG892 Design Flows Overview（Project vs Non-Project 模式） | 部分见 `vivado-tool-flow.md` §3 |
| 界面 | UG893 Using the Vivado IDE | — |
| 设计输入 | UG895 System-Level Design Entry | — |
| IP | UG896 Designing with IP / UG994 IP Integrator / UG1118 Custom IP 封装 | — |
| 仿真 | UG900 Logic Simulation（XSim 及第三方） | ✅ `vivado-tool-flow.md` §4 |
| **综合** | **UG901 Synthesis**（HDL 编码、语言支持、综合属性） | ✅ `vivado-synthesis-ug901.md` |
| 约束 | UG903 Using Constraints（XDC 写法） | 部分见 `timing-constraints.md` |
| 实现 | UG904 Implementation | — |
| 时序收敛 | UG906 Design Analysis and Closure Techniques | 部分见 `fpga-optimization.md` |
| 功耗 | UG907 Power Analysis and Optimization | — |
| 调试 / 下载 | UG908 Programming and Debugging（ILA / VIO / Hardware Manager） | — |
| 动态重构 | UG909 Dynamic Function eXchange | — |
| Tcl | UG894 Using Tcl Scripting / **UG835 Tcl Command Reference** | 脚本化流程必读；用法见 `vivado-tool-flow.md` |
| **方法学** | **UG949 UltraFast Design Methodology** | ✅ `ug949-rtl-methodology.md` |
| 发布说明 / 授权 | UG973 Release Notes, Installation, and Licensing | — |
| 教程 | UG937 / UG938 / UG939 / UG940 等（带工程文件） | — |

### 已验证的直达链接

```
UG910 入门     https://docs.amd.com/r/en-US/ug910-vivado-getting-started
UG901 综合     https://docs.amd.com/r/en-US/ug901-vivado-synthesis
UG908 调试     https://docs.amd.com/r/en-US/ug908-vivado-programming-debugging
UG949 方法学   https://docs.amd.com/r/en-US/ug949-vivado-design-methodology
```

其余 UG 的 URL 规律是 `docs.amd.com/r/en-US/ugXXX-<slug>`，但 **slug 各不相同，拼 URL
不可靠**——直接在 docs.amd.com 搜编号更快。

---

## §3 怎么读

1. **UG949 是总纲**，先从头过一遍。它会把你引到其他各本，也是本仓库 §10 综合可预测性
   规则的来源。
2. 再按当前卡住的环节查专门那本——**不要预先通读**，几十本 UG 通读一遍的收益远低于
   带着具体问题去查。
3. 查之前先确认本地是否已提炼（上表 ✅ 列）。本地版是按本仓库红线和实际踩坑裁剪过的，
   比原文更短且更贴合。
4. **[MUST] 从 UG 抄来的 TCL 和属性，落地前必须在本机这一版上实跑一次**，
   按 `docs/rules/01-hdl.md` §7 和 SKILL.md §10.1：不跑工具不下综合结论。

---

## 溯源与维护

§1/§2 的 UG 编号与入口来自外部资料，**未在本机逐条核实**。UG 编号本身跨版本稳定，
但各本的章节结构和具体命令会随版本变化，以 docs.amd.com 上你锚定的那一版为准。

本文**刻意不记录任何具体版本号和安装路径**：那既是机器特有信息（违反
`memory/learnings/desensitization-rule.md`），也会随工具升级立刻过期。需要版本时一律
现查（§0），不要在文档里固化快照。
