# Vivado 综合语言级参考（UG901）

> 来源: UG901 *Vivado Synthesis User Guide* — https://docs.amd.com/r/en-US/ug901-vivado-synthesis
> 关键子章节: HDL Coding Techniques / Verilog Language Support / SystemVerilog Support /
> Synthesis Attributes / RAM HDL Coding Guidelines
> （RAM 章节直达: https://docs.amd.com/r/en-US/ug901-vivado-synthesis/RAM-HDL-Coding-Guidelines）
>
> **本文是工程化摘要，不是官方文档的替代品。** 属性取值与构造支持状态随 Vivado 版本变化；
> 落地前按 `vivado-tool-flow.md` 里的 report 命令实测确认，不要凭本文断言"综合器一定会/不会"。
> 方法学级（怎么写才出好结果）见 `ug949-rtl-methodology.md`。

---

## §1 可综合子集 — 写 RTL 只用这一层

Vivado 综合只接受 Verilog / SystemVerilog / VHDL 的**可综合子集**，三者可在同一工程混用。
官方推荐在 RTL 里用 SystemVerilog 的理由：比 Verilog 更紧凑，`struct`/`enum` 带来更好的可扩展性，
`interface` 提供更高抽象层次，且 Vivado 综合原生支持。

### 1.1 RTL 允许使用（本仓库推荐面）

| 类别 | 构造 |
|:-----|:-----|
| 数据类型 | `logic`、`bit`、`byte`/`int`/`shortint`/`longint`、`typedef`、packed `struct`、packed `union`、`enum` |
| 数组 | packed array、multidimensional array、unpacked array（存储器建模） |
| 过程块 | `always_ff`、`always_comb`、`always_latch`（本仓库禁用，见 §5） |
| 控制流 | `if/else`、`case`/`casez`、`unique case`、`priority case`、`for`（可静态展开） |
| 层次 | `module`、`package`/`import`、`interface` + `modport`、`generate`/`genvar` |
| 子程序 | `function automatic`、`task automatic`（无时间控制） |
| 运算 | `++`/`--`、`+=`、`'{...}` 赋值模式、cast `T'(x)`、`$clog2`、`$bits` |
| 参数 | `parameter`、`localparam` |

### 1.2 RTL 禁止使用（验证特性，综合不支持）

| 类别 | 构造 | 说明 |
|:-----|:-----|:-----|
| OOP | `class`、`new`、继承、虚方法 | 纯验证特性 |
| 随机 | `rand`/`randc`、`constraint`、`randomize()` | 纯验证特性 |
| 动态容器 | 动态数组、关联数组、queue `[$]` | 无硬件对应 |
| 并发/同步 | `fork/join`、`wait`、`event`、`mailbox`、`semaphore`、clocking block、program block | 无硬件对应 |
| 断言 | SVA `property`/`sequence`/`assert property` | 仅 TB 用；综合不实现 |
| 强制 | `force`/`release`/`deassign` | 综合不支持 |
| 时间/实数 | `#delay`（综合忽略）、`real`（仅常量表达式）、`time` | 写进 RTL 会产生仿真-综合不一致 |
| 其他 | `specify` 块（忽略）、跨层次引用 `top.u1.sig`、`defparam`（受限） | — |

### 1.3 遇到拿不准的构造怎么办

1. 查 UG901 的 *Verilog Language Support* / *SystemVerilog Support* 章节 —— 那里有逐条的支持/受限表格；
2. 或直接实测：`synth_design -rtl` 跑一次 elaborate，不支持的构造会报 `[Synth 8-xxx]`；
3. **不要靠"仿真通过了"判断可综合性** —— xsim 接受的构造远多于综合器接受的。

### 1.4 `initial` —— 仅 RAM/ROM 存储器阵列（本仓库硬约束）

UG901：Vivado 综合可将 **存储器/部分寄存器** 的上电初值写入配置位流。  
本仓库进一步收紧为与门禁 `G-C-03` 一致：

| 规则 | 要求 |
|:-----|:-----|
| **允许** | `initial` 块**只**对 **unpacked 存储器阵列**（RAM/ROM）赋值：常量、`for` 静态展开常量、`$readmemh`/`$readmemb` |
| **禁止** | 对标量/向量 FF、FSM、指针、valid、计数器等做 `initial`（仿真执行、综合常忽略 → 上板不一致） |
| **禁止** | 用 `initial` 充当复位；ASIC 目标不得依赖 `initial` |
| **禁止** | `initial` 内写运行时条件/非常量路径导致整块被 `[Synth 8-6896]` 丢弃 |
| **UltraRAM** | **不支持**上电初值 → 勿对 URAM 写 `initial` 并期望生效 |
| **验证** | 阵列-only `initial` 综合后日志须无 `[Synth 8-6896]`；利用率中 ROM/RAM 映射符合预期 |
| **TB** | Testbench 可用任意 `initial`；本规则只约束**综合 RTL** |

```systemverilog
// ✅ ROM 初值
(* rom_style = "block" *) logic [7:0] r_rom [0:255];
initial $readmemh("coeff.hex", r_rom);

// ✅ RAM 上电清零（仍建议用 for 静态展开常量，勿写依赖仿真时刻的逻辑）
logic [31:0] r_mem [0:1023];
integer init_i;
initial begin
  for (init_i = 0; init_i < 1024; init_i = init_i + 1)
    r_mem[init_i] = 32'h0;
end

// ❌ 标量 / 控制寄存器
// initial r_state = 2'd0;
// initial ro_valid = 1'b0;
```

> **初值 ≠ 复位**：配置时生效；运行时 `i_rst` 不会把阵列拉回初值。  
> 需要运行时清空时，用控制逻辑 + 写端口显式写，或接受 valid 屏蔽脏数据。

---

## §2 推断模板（Know What You Infer 的语言侧）

UG901 的 *HDL Coding Techniques* 给出各类硬件的推断模板。核心认知：
**综合器是模式匹配，不是意图理解。** 写法偏离模板一点点，推断就掉到 fabric 上。

| 目标硬件 | 推断条件 | 常见破坏推断的写法 |
|:---------|:---------|:-------------------|
| **FF (FDRE/FDSE)** | `always_ff @(posedge clk)` + 非阻塞赋值 | 同一 always 混用阻塞/非阻塞；多驱动源 |
| **Latch** | `always_comb` 分支不完整 | **本仓库红线 5：任何 latch 推断即 FAIL** |
| **三态 (OBUFT)** | `assign o = en ? d : 1'bz;` | 内部三态（非 IO）会被综合成 MUX，别在片内用 |
| **移位寄存器 (SRL16/SRL32)** | 无复位、无中间抽头的定长移位链 | ① 带复位 → 掉 FF；② 有中间抽头 → 掉 FF；③ `SHREG_EXTRACT="no"` |
| **动态移位 (SRL 可变深度)** | 移位链 + 可变地址读出（`shift_reg[addr]`） | 抽头带复位 |
| **乘法器 (DSP48)** | `a * b`，位宽在 DSP 输入范围内 | 位宽超限 → 拆多个 DSP + LUT 组合；有复位的中间寄存器 |
| **Multiply-Add / MAC** | `p <= p + a*b;` 且乘加寄存器紧邻 | 累加器带异步复位；乘法输出多扇出 → MREG 吸收失败 |
| **分布式 RAM (LUTRAM)** | 小容量、**异步读**（组合读出） | — |
| **块 RAM (BRAM)** | **同步读**（读地址寄存 + 读数据寄存） | 见 §3 |
| **ROM** | `case` 常量表 或 带初值的只读数组 | 容量小 → 走 LUT；用 `ROM_STYLE` 强制 |
| **FSM** | 状态寄存器 + `case` 次态逻辑 | 状态编码用 `FSM_ENCODING` 控制 |

### 2.1 存储器推断的分水岭：同步读 vs 异步读

```systemverilog
// 分布式 RAM（LUTRAM）：读是组合的
logic [7:0] mem [0:63];
always_ff @(posedge i_clk) if (r_we) mem[r_waddr] <= r_wdata;
assign w_rdata = mem[r_raddr];              // 异步读 → LUTRAM

// 块 RAM（BRAM）：读地址必须被寄存
logic [7:0] mem [0:1023];
always_ff @(posedge i_clk) begin
  if (ri_we) mem[ri_waddr] <= ri_wdata;
  ro_rdata <= mem[ri_raddr];                // 同步读 → BRAM
end
```

### 2.2 读写同步模式（BRAM）

同一地址同周期读写时的行为，由 HDL 写法决定，三选一：

| 模式 | 写法要点 | 读出值 |
|:-----|:---------|:-------|
| **Read-First** | 读语句在写语句**之前** | 写之前的旧值 |
| **Write-First** | 读语句在写语句**之后**（或读 `wdata`） | 正在写入的新值 |
| **No-Change** | 读语句放在 `if (!we)` 分支内 | 写周期输出保持不变（**功耗最低**） |

> 没有明确需求时选 **No-Change** —— 它省功耗，且在 UltraRAM 上兼容性最好。
> 选定后**必须**在 Golden Model / TB 里用同样语义建模，否则 RTL vs GM 会在同址读写点上偏差。

### 2.3 存储器初值

- **仅**用 `initial` / `$readmemh` / `$readmemb` 给 **阵列** 赋初值 → 综合器写进配置位流（§1.4）；
- **UltraRAM 不支持上电初值**（URAM 上电为 0）；
- 初值不是复位：重配置才恢复，运行时 `i_rst` 拉高不会让存储器回到初值；
- **禁止**用同步复位循环清整块大 RAM（慢、占逻辑）；需要确定性内容时用初值或显式写端口。

### 2.4 其它 HDL Coding Techniques 速记（薄弱项补齐）

| 结构 | 推荐写法 | 破坏/陷阱 |
|:-----|:---------|:----------|
| **计数器** | `always_ff` + 同步复位 + 使能；位宽够用 | 异步复位；组合自增 |
| **多路选择** | 完整 `case`/`unique case` | 长 `if-else` 优先链（无优先级需求时） |
| **移位/延时** | 无复位定长链 → SRL | 复位或中间抽头 → FF 链 |
| **乘法/MAC** | `*` / `p <= p + a*b` 紧邻寄存器 | 中间寄存器加复位/多扇出 |
| **`casex`** | **禁用** | X 匹配仿真综合不一致 |
| **`casez`** | 慎用；意图注释 | 掩码位语义不清 |
| **signed** | 操作数同 signed；显式扩展 | 混 signed/unsigned |
| **generate for** | 界为常量/parameter | 运行时可变界 |

权威示例：Vivado → Language Templates；抄完改 `ri_`/`ro_` 与 §5 复位策略。

---

## §3 RAM 编码细则（RAM HDL Coding Guidelines）

### 3.1 选型判据

| 资源 | 适用 | 特征 |
|:-----|:-----|:-----|
| 分布式 RAM | 深度 ≤ 64~256、需要异步读、小 FIFO | 吃 LUT，无专用输出寄存器 |
| 块 RAM | 中大容量、同步读、需要高 Fmax | 有可选输出寄存器（+1 拍，Fmax 大幅提升） |
| UltraRAM | UltraScale+ 上的大容量（288Kb/块） | **单时钟**、**无初值**、级联友好、功耗低 |

### 3.2 `RAM_STYLE` / `ROM_STYLE`

```systemverilog
(* ram_style = "block" *) logic [17:0] r_mem_array [0:2047];
```

| 取值 | 含义 |
|:-----|:-----|
| `"block"` | 强制块 RAM |
| `"distributed"` | 强制 LUTRAM |
| `"registers"` | 强制 FF 实现（小深度、要求极致时序时） |
| `"ultra"` | 强制 UltraRAM（不满足 URAM 约束时会回落，**必须看综合日志确认**） |
| `"mixed"` / `"auto"` | 交给工具决策（默认） |

`ROM_STYLE` 取 `"block"` / `"distributed"`。

### 3.3 BRAM 输出寄存器 —— 最常见的性能事故

块 RAM 内部有一级可选输出寄存器（DOB_REG）。综合器只有在**你在 RTL 里写了那一级寄存器
且它能被吸收**时才会启用。吸收失败 = 寄存器留在 fabric + BRAM 走非寄存输出，Fmax 掉一大截，
而且**没有任何报错**。三条典型阻断条件见 `ug949-rtl-methodology.md` §4。

```systemverilog
// 正确：读数据寄存器紧跟 BRAM 读、无复位、单扇出
always_ff @(posedge i_clk) begin
  r_rdata_bram <= r_mem_array[ri_raddr];   // BRAM 本体
  ro_rdata     <= r_rdata_bram;            // 输出寄存器 → 被吸收进 BRAM
end
```

> **与本仓库红线 3 的冲突点**：红线要求输出由 `ro_` 驱动、同步复位高有效。
> 若给 `ro_rdata` 加上 `if (i_rst) ro_rdata <= '0;`，**输出寄存器吸收会失败**。
> 处理办法：数据通路上的 BRAM 输出寄存器**不加复位**（数据无效由 valid 通道控制），
> 只在 valid/控制信号上做复位。这是 §5 记录的合规豁免。

---

## §4 综合属性速查

写法：Verilog/SV 用 `(* attr = "value" *)`，放在被修饰对象声明的紧前面。

| 属性 | 作用对象 | 取值 | 典型用途 |
|:-----|:---------|:-----|:---------|
| `KEEP` | net/signal | `"true"` | 阻止该信号被优化掉（便于约束/调试） |
| `KEEP_HIERARCHY` | module/instance | `"yes"` | 保住层次边界，便于分析与约束 |
| `DONT_TOUCH` | signal/instance | `"true"` | 综合+实现全程不动 —— **手工寄存器复制必须加，否则副本会被合并回去** |
| `MAX_FANOUT` | signal/module | 整数 | 让工具自动复制驱动器降扇出 |
| `RAM_STYLE` / `ROM_STYLE` | 数组信号 | 见 §3.2 | 存储器映射控制 |
| `SRL_STYLE` | 移位信号 | `"register"`/`"srl"`/`"srl_reg"`/`"reg_srl"`/`"reg_srl_reg"`/`"block"` | 移位链映射到 SRL / FF / BRAM |
| `SHREG_EXTRACT` | signal/module | `"yes"`/`"no"` | 关闭 SRL 推断（想要真 FF 时） |
| `USE_DSP` | signal/module | `"yes"`/`"no"`/`"logic"` | 算术是否走 DSP48 |
| `CASCADE_HEIGHT` | RAM 数组 | 整数 | 限制 BRAM 级联深度（功耗/时序权衡） |
| `FSM_ENCODING` | 状态寄存器 | `"one_hot"`/`"sequential"`/`"gray"`/`"johnson"`/`"auto"`/`"none"` | 覆盖自动状态编码 |
| `ASYNC_REG` | 同步链 FF | `"true"` | **CDC 同步器必加**：告诉工具该 FF 可能亚稳态，布局时打包靠近、时序上放宽 |
| `DIRECT_ENABLE` | signal | `"true"` | 强制该信号直接进 FF 的 CE 引脚（不被综合成 LUT） |
| `DIRECT_RESET` | signal | `"true"` | 强制该信号直接进 FF 的 SR 引脚 |
| `EXTRACT_ENABLE` | signal/module | `"yes"`/`"no"` | 禁止把使能条件提到 CE 引脚（**降控制集数量**） |
| `EXTRACT_RESET` | signal/module | `"yes"`/`"no"` | 禁止把复位条件提到 SR 引脚（同上） |
| `IOB` | port FF | `"true"` | 把寄存器推进 IO 单元（改善 IO 时序） |
| `MARK_DEBUG` | net | `"true"` | 保留信号供 ILA 抓取 |
| `BLACK_BOX` | module | `"yes"` | 该模块不综合（外部提供网表） |

### 4.1 使用纪律

- **[MUST]** 每个属性旁写一行注释说明**为什么**加 —— 属性是对综合器的强制指令，无注释的属性
  在后续维护里没人敢删，会长期锁死一个可能早已过时的决策。
- **[MUST]** 加属性后必须用报告验证它真的生效（`report_utilization` / 综合日志 / `report_control_sets`）。
  属性写错名字或取值时，Vivado 只给 warning 甚至静默忽略。
- **[SHOULD]** 优先改代码结构，属性是最后手段。`MAX_FANOUT` 治不了架构上的广播信号。

---

## §5 与本仓库红线的交叉点

| 本仓库规则 | UG901/UG949 立场 | 结论 |
|:-----------|:-----------------|:-----|
| 红线 1/2 输入输出寄存 `ri_`/`ro_` | UG949 推荐"在逻辑边界打拍" | **一致** |
| 红线 3：**凡复位**须同步高有效 `i_rst` | UG949 推荐同步复位；**数据通路尽量无复位** | **一致**：红线约束极性/同步性，**不**强制每寄存器复位 |
| 数据通路少复位（SKILL §1.1） | UG949 Control Sets / Resets | **对齐**：默认数据流水无复位 |
| 红线 4 三段式 FSM + default | UG901 FSM 推断模板要求 `default` | **一致** |
| 红线 5 无锁存器 | `always_latch` 可综合但不推荐 | **一致**，禁用 `always_latch` |
| `initial` 仅 RAM/ROM 阵列 | UG901 上电初值；防仿真-综合差 | **本仓库更严**：禁止标量 initial（§1.4 / G-C-03） |

### 5.1 复位：推荐不复位 vs 硬豁免

**A. 推荐不复位（默认写法）** — 纯数据流水寄存器  

- 无效数据由 **valid/enable** 屏蔽；少复位 → 控制集少、FF 打包好、利于 Fmax  
- 审查默认删掉数据通路上的“顺手 `if (i_rst)`”，除非有协议/安全书面理由  

**B. 硬豁免（必须不复位 + 注释 + 报告）** — 加了会阻断宏吸收  

1. BRAM 的读数据寄存器与输出寄存器；  
2. DSP48 内部流水（AREG/BREG/MREG/PREG 对应 RTL 寄存器）；  
3. SRL 移位链中间级（有复位 → FF 链，面积膨胀约 32×）。  

**硬豁免条件（三条都要满足）：**

- 寄存器在数据通路上，无效数据由 **valid/enable** 屏蔽；valid/控制通道**必须有** `i_rst`；  
- RTL 注释：`// [复位豁免] BRAM 输出寄存器吸收 — 见 vivado-synthesis-ug901.md §5.1`；  
- 综合后 `report_utilization` 确认 BRAM/DSP/SRL 映射符合预期。  

**C. 必须复位** — FSM、valid 链、指针/计数器、配置寄存器（同步高有效 `i_rst`）。

> 红线 3 的含义是：“要复位就用同步高有效 `i_rst`”，**不是**“每个 `r_` 都要进复位分支”。

---

## 相关文件

- 方法学级指南（层次/控制集/Fmax/功耗/CDC）: `ug949-rtl-methodology.md`
- Vivado 工具命令与 TCL 脚本: `vivado-tool-flow.md`
- 存储器模板: `memory-templates.md`
- 时序约束: `timing-constraints.md`
- 资源与时序优化: `fpga-optimization.md`
- 技能主文: `../SKILL.md` §1.1 / §1.2 / §10
