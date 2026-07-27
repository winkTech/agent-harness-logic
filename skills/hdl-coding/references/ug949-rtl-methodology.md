# Vivado RTL 方法学（UG949 / UG1192）

> 来源: UG949 *UltraFast Design Methodology Guide* — RTL Coding Guidelines 章节
> https://docs.amd.com/r/en-US/ug949-vivado-design-methodology/RTL-Coding-Guidelines
> 官方定位：自己写 RTL 实现互连逻辑、或没有合适 IP 的功能时，按本节指南能得到最优结果；
> 更细的语言级规则去 UG901（见 `vivado-synthesis-ug901.md`）。
>
> 本章节的子节：Using Vivado HDL Templates / Control Signals and Control Sets / Resets /
> Clock Enables / **Know What You Infer** / Synthesis Tool Optimization /
> Coding Styles to Improve Maximum Frequency / Coding Styles to Improve Power / **Running RTL DRCs**
>
> **UG901 管"综合器能识别什么"，UG949 管"怎么写才出好结果"。** 红线管不到的性能问题，答案基本在这里。

---

## §1 设计层次划分

层次不是组织代码的美学问题，是**布局布线和时序收敛的骨架**。高速 DSP 设计尤其需要前期规划。

| 规则 | 做法 | 理由 |
|:-----|:-----|:-----|
| I/O 组件靠近顶层 | IBUF/OBUF/IDDR/ODDR/ISERDES 放顶层或顶层下一级 | IO 位置固定，深埋会拉长布线 |
| 时钟元件靠近顶层 | MMCM/PLL/BUFG/BUFGCE 在 RTL 顶层例化 | 时钟树必须全局可见；深埋导致时钟走局部布线 |
| 在逻辑边界打拍 | 模块进出口寄存 | 与本仓库红线 1/2 一致；给布线留出整拍余量 |
| 层次服务于调试 | 功能边界 = 层次边界，便于逐级抓波形/加约束 | 层次被打平后信号名消失，ILA 抓不到 |
| 属性施加在模块级 | `KEEP_HIERARCHY`、`USE_DSP`、`MAX_FANOUT` 挂模块而非逐信号 | 少写、易维护、便于整块替换策略 |

**落地**：本仓库 `01_src/00_hdl/<module>/<module>.sv` 一模块一目录的结构已符合；
顶层 top 模块（`01_src/00_hdl/top/top.sv`）里**只**放时钟/复位/IO 元件 + 子模块例化，不写功能逻辑。

---

## §2 控制信号与控制集（Control Sets）

**控制集 = {时钟, 时钟使能 CE, 置位/复位 SR} 的组合。** 同一个 SLICE/CLB 内的触发器**必须共享
同一个控制集**才能打包在一起。控制集种类越多 → FF 打包密度越低 → 面积虚高、布线拥塞、Fmax 下降。

### 2.1 减少控制集的手段

1. **数据通路寄存器不加复位**（最有效，见 §3）；
2. 合并语义相同的使能信号，不要每个寄存器一个私有 enable；
3. 用 `EXTRACT_ENABLE="no"` / `EXTRACT_RESET="no"` 阻止综合器把 `if` 条件提到 CE/SR 引脚
   —— 条件退回 LUT 逻辑，控制集数量下降（代价是多一点 LUT）；
4. 反向操作：关键路径上 CE 逻辑太深时，用 `DIRECT_ENABLE="true"` / `DIRECT_RESET="true"`
   强制该信号直连 FF 的 CE/SR 引脚，绕开 LUT 级。

### 2.2 怎么看

```tcl
report_control_sets -verbose -file 04_prj/rpt/control_sets.rpt
```
关注 unique control set 总数与 FF 总数的比值。比值高 + 利用率报告里 "Slice" 数远高于
`FF/8` 的理论值 → 说明打包失败，回来砍复位/合并使能。

### 2.3 复位与时钟使能的优先级 —— 高频踩坑

Xilinx 触发器（FDRE）的硬件行为是：**同步复位 R 受 CE 门控**（`CE=1 且 R=1` 才复位）。
如果 RTL 把复位写在使能外层（复位优先级高于 CE），综合器必须**额外加逻辑**把复位并进 CE。

```systemverilog
// ❌ 复位优先于 CE — 综合器要额外造 (ce | i_rst) 逻辑，控制集变复杂
always_ff @(posedge i_clk) begin
  if (i_rst)      r_data <= '0;
  else if (r_ce)  r_data <= w_din;
end

// ✅ 复位在 CE 内层 — 直接映射到 FDRE，无额外逻辑
always_ff @(posedge i_clk) begin
  if (r_ce) begin
    if (i_rst) r_data <= '0;
    else       r_data <= w_din;
  end
end
```

> **本仓库取舍**：控制逻辑（FSM、计数器、valid 链）**保持复位优先**的写法 —— 语义清晰、
> 复位行为可预测，这点额外逻辑不值得冒功能风险。只有当 `report_control_sets` 显示打包
> 确实成为瓶颈、且该寄存器在关键路径上时，才改成 CE 内层写法，并在注释里注明原因。

---

## §3 复位策略

### 3.1 三条原则

1. **能不复位就不复位。** 数据通路寄存器绝大多数不需要复位 —— 无效数据由 valid 通道屏蔽。
   复位加得越多，控制集越多、BRAM/DSP/SRL 推断被阻断得越多。
2. **必须复位时用同步复位。** 异步复位会：占用 FF 的 SR 引脚、阻止 BRAM 输出寄存器吸收、
   阻止 DSP 内部寄存器吸收、阻止 SRL 推断、且复位释放时刻不可控。
3. **异步复位源必须做同步释放。** 异步断言 + 同步释放（reset synchronizer），同步链上加
   `ASYNC_REG="true"`。模板见 `reset-templates.md`。

### 3.2 哪些一定要复位

| 必须复位 | 理由 |
|:---------|:-----|
| FSM 状态寄存器 | 上电必须进入已知状态 |
| valid / ready / enable 等控制通道 | 决定数据有效性，误判会污染下游 |
| 计数器、指针（FIFO 读写指针） | 位置错误无法自恢复 |
| 配置/状态寄存器 | 需要确定的默认值 |

| 不复位（推荐） | 理由 |
|:---------------|:-----|
| 纯数据流水寄存器 | 由 valid 屏蔽，复位无收益 |
| BRAM 读数据/输出寄存器 | 复位会阻断吸收 → Fmax 崩 |
| DSP 内部流水寄存器 | 同上 |
| SRL 移位链中间级 | 复位会让 SRL 掉成 FF 链 |

> 本仓库红线 3 要求"同步复位高有效 `i_rst`"，与上表**不冲突**：红线约束的是
> "只要复位就必须是同步高有效 `i_rst`"，不是"每个寄存器都要复位"。
> 数据通路豁免的执行细则（注释 + 验证）见 `vivado-synthesis-ug901.md` §5.1。

---

## §4 Know What You Infer —— 本章最值钱的一节

综合器推断硬件宏（BRAM / UltraRAM / DSP48 / SRL）时，**失败是静默的**：不报错，
只是把逻辑摊到 fabric 上。RTL 功能仿真照样全对，等综合完看利用率报告才发现
BRAM 用了 0 块、LUT 爆了 3 倍。

### 4.1 块 RAM 输出寄存器吸收失败的三条件

UG949 明确点名，这三种写法会让输出寄存器留在 fabric：

| # | 阻断条件 | 症状 | 修法 |
|:-:|:---------|:-----|:-----|
| 1 | **读数据寄存器输出有多扇出** | 输出寄存器不能进 BRAM，只能留 fabric | 每个消费者复制一份自己的输出寄存器，或先寄存再分发 |
| 2 | **地址寄存器或读数据寄存器上带复位** | 尤其异步复位；BRAM 地址寄存器根本没有复位端 | 去掉复位（走 §3.2 豁免） |
| 3 | **寄存器里存在反馈结构** | 输出寄存器参与反馈路径（如读-改-写累加） | 把反馈级拆出来单独做，BRAM 输出级保持单向 |

**验证方式**：综合后 `report_utilization` 看 BRAM 块数；再看 `report_timing_summary` 的
关键路径起点是不是 BRAM 的 DO 端口 —— 如果关键路径从 BRAM 组合输出直接出来，
说明输出寄存器没吸收进去。

### 4.2 UltraRAM (URAM) 映射条件

URAM 只在 UltraScale+ 上有，且约束比 BRAM 严：

- **单时钟**：两个端口必须同一时钟，不能做真双时钟；
- **无上电初值**：不能用 `initial` / `$readmemh` 初始化；
- **无异步复位**；
- 深度形状要匹配（288Kb / 4096×72 基本块），太小的存储器不会映射；
- 需要 `(* ram_style = "ultra" *)` 显式声明。

不满足时综合器**静默回落到 BRAM**。加了 `"ultra"` 属性后**必须**查综合日志和利用率报告确认。

### 4.3 DSP48 推断与流水

- `a*b` 和 `p <= p + a*b` 是标准模式；位宽超出 DSP 输入范围会拆成多 DSP + LUT 拼接；
- DSP48 内部有 AREG/BREG/MREG/PREG 多级流水。**你在 RTL 里写几级紧邻的寄存器，
  综合器就能吸收几级**。全流水（输入 1~2 级 + M 级 + P 级）能把 DSP 跑到器件极限频率；
- 这些内部流水寄存器**不能带复位**，也不能有中间扇出，否则吸收失败；
- 方法学检查里的 `DPIP-*`（DSP 输入流水）/ `DPOP-*`（DSP 输出流水）家族违规，
  说的就是"你的 DSP 没有充分流水"，见 §7。

### 4.4 SRL 与延时线

- 无复位、无中间抽头的定长移位链 → SRL16E/SRL32E，**1 个 LUT 装 32 拍**，比 32 个 FF 省 32 倍；
- 一旦加复位或取中间抽头，整条链掉回 FF；
- 用 `SRL_STYLE` 精确控制：`"srl_reg"`（SRL + 尾部 FF，改善时序）、`"reg_srl_reg"`（首尾都加 FF）；
- **权衡**：SRL 省面积但输出时序差（LUT 输出延迟）。关键路径上的延时线用 `"srl_reg"`。
- 本仓库 `templates/comm/pipe_delay.sv` / `delay_sync.v` 属于这一类，改深度时注意别顺手加复位。

### 4.5 寄存器/SRL/存储器初值

- FPGA 支持上电初值（写进配置位流），可以替代一部分复位需求；
- **初值 ≠ 复位**：只在配置时生效，运行时 `i_rst` 不会恢复初值；
- ASIC 目标下初值完全无效 —— 本仓库 RTL 禁 `initial`，用初值请走参数化的复位默认值。

---

## §5 提升 Fmax 的编码风格

| 手段 | 做法 | 注意 |
|:-----|:-----|:-----|
| **降高扇出** | 关键路径上的高扇出网：手工寄存器复制（副本加 `DONT_TOUCH`），或 `MAX_FANOUT` 让工具做 | 手工复制不加 `DONT_TOUCH` 会被综合器合并回去，等于没做 |
| **按负载分组复制** | 每个负载区域一份副本，复制寄存器放在对应层次内 | 盲目复制会增加控制集和面积 |
| **流水线** | 在长组合链中插寄存器；SSI（多 SLR）器件**跨 SLR 必须打拍** | 增加延迟，需与 `architecture.yaml` 的 latency 契约同步更新 |
| **宏原语流水** | BRAM 用输出寄存器、DSP 用内部寄存器（§4.1/§4.3） | 这是"免费"的流水级，优先用满 |
| **避免过度流水** | 过深流水会推高 SRL 使用、拉长延迟、增加对齐难度 | 先测再加，不要预防性堆流水 |
| **检查推断结果** | 每次优化后跑 `report_utilization` + `report_timing_summary` | 见 `vivado-tool-flow.md` |

**查扇出**：
```tcl
report_high_fanout_nets -fanout_greater_than 200 -max_nets 50 -file 04_prj/rpt/high_fanout.rpt
```

---

## §6 降功耗的编码风格

| 手段 | 做法 |
|:-----|:-----|
| **门控数据通路** | 数据无效时用 CE 冻结寄存器，不让它空翻转 |
| **门控点尽量靠上游** | 一个使能覆盖越多下游寄存器越省 |
| **用 BUFGCE 的 CE 引脚，不做门控时钟** | `always @(posedge (clk & en))` 是**禁止写法**：走局部布线、时钟偏移不可控、方法学检查直接报违规 |
| **用 `case` 代替优先编码** | 不需要优先级时，`if-else` 链会综合成级联 MUX（面积/延迟/功耗都差），`case` 综合成平坦 MUX |
| **BRAM 用 EN 门控** | 不读的周期把 BRAM 的 EN 拉低，比只用 CE 省得多 |
| **深存储器分解 / 限制级联** | 用 `CASCADE_HEIGHT` 减少每次访问激活的 BRAM 数，功耗与 Fmax 折中 |

---

## §7 时钟与跨时钟域（含 UG1192 浓缩 checklist）

### 7.1 时钟 checklist

- [ ] **避免门控时钟** —— 改用全局时钟缓冲上的时钟使能（BUFGCE）
- [ ] **时钟元件保持在 RTL 顶层**（MMCM/PLL/BUFG）
- [ ] **走专用全局时钟布线**，而非局部布线（`report_clock_networks` 确认）
- [ ] **不级联时钟缓冲**（BUFG 串 BUFG）—— 插入延时叠加且不可预测
- [ ] **需要两个相关时钟时用并联时钟缓冲**（同源并联 BUFG），保证可预测布局与匹配的插入延时
- [ ] 每个时钟都有 `create_clock` / `create_generated_clock` 约束（见 `timing-constraints.md`）

### 7.2 CDC

| 场景 | 方案 | 关键点 |
|:-----|:-----|:-------|
| 单 bit 电平 | 2~3 级同步器 | 目标域 FF 加 `ASYNC_REG="true"`；源端必须是寄存器输出，不能是组合逻辑 |
| 单 bit 脉冲 | 展宽成电平 → 同步 → 边沿检测；或握手 | 直接同步窄脉冲会丢 |
| 多 bit 计数/指针 | 格雷码 + 同步 | 只有相邻值单 bit 变化才安全 |
| 多 bit 数据总线 | 异步 FIFO，或"数据不同步 + enable 同步"的 MUX 同步 | 数据路径打 `set_max_delay -datapath_only` |
| 复位跨域 | 复位同步器（异步断言 + 同步释放） | 见 `reset-templates.md` |

**同步级数**：XPM_CDC 宏用 `DEST_SYNC_FF` 参数控制（典型 2~4；亚稳态裕量要求高或时钟频率高时取 4）。

**优先用官方 XPM_CDC 宏而不是手写同步器**（Vivado 自带，`report_cdc` 能识别并豁免）：

| 宏 | 用途 |
|:---|:-----|
| `xpm_cdc_single` | 单 bit 电平 |
| `xpm_cdc_gray` | 格雷码计数器跨域 |
| `xpm_cdc_handshake` | 多 bit 数据 + 握手 |
| `xpm_cdc_array_single` | 多 bit 独立位（各位不相关时） |
| `xpm_cdc_pulse` | 脉冲跨域 |
| `xpm_cdc_sync_rst` | 同步复位跨域 |

> 本仓库 `templates/comm/cdc_sync.sv` 是手写版本，接口符合 `ri_`/`ro_` 规范。
> 新设计若不受命名约束（如直接在顶层例化），**优先用 XPM_CDC** —— 工具能自动识别、
> `report_cdc` 不会误报、且已内置 `ASYNC_REG`。

**验证**：
```tcl
report_cdc -details -file 04_prj/rpt/cdc.rpt
report_clock_interaction -delay_type min_max -file 04_prj/rpt/clock_interaction.rpt
```
`report_cdc` 里 **Critical / Warning 级别的 CDC 必须清零或书面豁免**，这是本仓库 Phase 5 集成的门禁项。

---

## §8 Running RTL DRCs —— 比读文档快

UG949 自己就有一节叫 *Running RTL DRCs*：跑一遍就直接告诉你哪些写法违反官方方法学。

```tcl
# elaborate 级（不需要完整综合，秒级出结果）
synth_design -rtl -rtl_skip_mlo -top ${top} -part ${part}
report_drc -file 04_prj/rpt/rtl_drc.rpt

# 综合/实现后跑完整方法学检查
report_methodology -file 04_prj/rpt/methodology.rpt
```

### 8.1 违规家族与本仓库规则的对应

规则编号随 Vivado 版本变化，按**前缀家族**理解即可（报告里每条都带 description）：

| 家族 | 含义 | 对应本仓库规则 |
|:-----|:-----|:---------------|
| `TIMING-*` | 时序约束缺失/不完整、时钟组未定义、组合环 | `timing-constraints.md`；组合环对应红线 5 |
| `CKLD-*` | 时钟走非专用布线（门控时钟的典型症状） | §7.1 |
| `LUTAR-*` / 异步复位类 | LUT 驱动异步复位 | 红线 3 |
| `SYNTH-*` | 综合层面的写法问题（推断失败、黑盒等） | §4 |
| `DPIP-*` / `DPOP-*` | DSP 输入/输出流水不足 | §4.3 |
| `XDCH-*` | XDC 约束顺序/作用域问题 | `timing-constraints.md` |
| `PDRC-*` | 布局/布线阶段的物理设计规则 | 实现阶段处理 |
| `MDRV-*` | 多驱动网络 | 红线级错误，必须修 |

### 8.2 本仓库门禁立场

- **[MUST]** 综合前跑 RTL DRC，**Critical Warning 必须清零**；
- **[MUST]** 综合后跑 `report_methodology`，Critical 必须清零，Warning 逐条判定（豁免要写进
  `06_doc/` 并注明理由）；
- **[SHOULD]** `report_qor_suggestions` 的建议逐条评估（它会给出可直接 apply 的 TCL）。

一键脚本：`skills/vivado-flow/scripts/vivado_flow.tcl` —— `-to rtlcheck` 是 elaborate 级体检，
`-from rtlcheck -to synth` 是综合后全套报告。用法见 `vivado-tool-flow.md` 与 `skills/vivado-flow/SKILL.md`。

---

## §9 Vivado HDL 模板（Language Templates）

Vivado IDE → **Window → Language Templates** 里有官方推断模板（RAM/ROM/SRL/DSP/FSM/XPM/IO 原语），
直接可抄，是 §4 各类推断的权威写法来源。UG901 的编码示例也提供文件下载。

**用法纪律**：抄模板后**必须**按本仓库 §2 命名规范改成 `i_`/`o_`/`ri_`/`ro_`/`r_`/`w_`，
并把复位改成 `i_rst`（数据通路豁免除外）。直接粘官方模板会挂在命名审查上。

---

## 相关文件

- 语言级/属性/推断模板: `vivado-synthesis-ug901.md`
- 工具命令与 TCL 脚本: `vivado-tool-flow.md`
- 时序约束: `timing-constraints.md`
- 优化技巧（扇出/拥塞/功耗）: `fpga-optimization.md`
- 复位/CDC 模板: `reset-templates.md`、`templates/comm/cdc_sync.sv`
