---
name: hdl-coding
description: HDL 编码规范 — FPGA/ASIC 的 Verilog/SystemVerilog 工作：RTL 模块、Testbench、模块例化、流水线、CDC、状态机、代码审查，以及 FPGA 架构原理讲解、RTL 框图和 Vivado 综合/工具流（综合属性、推断规则、report_methodology/RTL DRC/report_cdc、XDC、xsim）。强制 ri_/ro_ 命名、输入输出寄存、三段式 FSM、无锁存器；initial 仅允许 RAM/ROM 阵列初值；数据通路推荐少复位以利 BRAM/DSP/SRL 宏吸收。纯 Python/MATLAB、工具安装、算法调研不适用。
version: 3.9.0
---

# HDL 编码规范

## 适用边界
**必须使用**: RTL 编写、Testbench、模块例化、时序约束。
**可跳过**: 纯文档/注释、已完成的代码审查（但 lint 仍需）。
**前置加载**: 编写 RTL 前先读 `references/RTL_DESIGN_RULE.md` 的 §代码对齐规范；涉及星座映射、查找表、比特-符号编码的模块，再加读 §LUT/映射门禁。
涉及**存储器 / DSP 乘加 / 移位链延时 / CDC / 综合属性 / initial 初值 / 复位策略**，或需要给出**资源、Fmax、时序、可综合性**结论时，加读 `references/vivado-synthesis-ug901.md`、`references/ug949-rtl-methodology.md` 与 `references/vivado-tool-flow.md`（见 §1.1、§1.2、§10）。

---

## 必读红线（5 条 — 违反任何一条 = FAIL）

> 与 `docs/rules/01-hdl.md` 的红线一一对应，两处必须保持同步。**为什么严格？** 组合直出的信号会把毛刺传播到下一级；未寄存的输入在布局布线后时序收敛困难；锁存器不会被 lint 报错，却导致上板功能随机失败。这些都是实际项目中烧过板的教训。

1. **[MUST]** 输入信号必须寄存为 `ri_`，禁止直通 → 否则 FAIL
2. **[MUST]** 输出必须由 `ro_` 驱动，禁止组合直出 → 否则 FAIL
3. **[MUST]** **凡使用复位**必须是同步高有效 `i_rst`；异步源必须做同步释放 → 否则 FAIL  
   > 红线 3 **不要求**每个寄存器都复位。数据通路推荐少复位（§1.1）；BRAM/DSP/SRL 宏吸收场景见豁免 §10.2。
4. **[MUST]** 三段式状态机 + `default` 分支 → 否则 FAIL
5. **[MUST]** 无锁存器：if→else、case→default、assign→完整条件（排查法见 §8）→ 否则 FAIL

### 附加硬约束（与红线同级，审查/门禁 FAIL）

6. **[MUST]** `initial` **仅允许**给 **RAM/ROM 存储器阵列**赋上电初值（可含 `$readmemh`/`$readmemb`）；禁止给标量/向量 FF、FSM、指针、valid 等赋 `initial` → 否则 FAIL（对齐 UG901 + 门禁 `G-C-03`）
7. **[MUST]** Testbench 可用任意 `initial`/`force`/`#delay`；**综合 RTL** 禁止 `force`/`release`/`disable`/`#delay`（功能性）

---

## §1 时序安全

红线 1、2、3、5 的展开理由与补充规则：

1. **同步复位**（红线 3）— 详见 §1.1  
   - *原因*：Xilinx 类架构推荐同步高有效；异步释放未同步会产生亚稳态
2. **输入寄存**（红线 1）
   - *原因*：组合输入在时序分析中无明确起点，导致时序收敛困难
3. **输出寄存**（红线 2）
   - *原因*：组合输出 = 毛刺发射器，下游每级都可能采到错误值
4. **CDC** — 异步输入双寄存同步，加 `_cdc` 后缀（模板: `templates/comm/cdc_sync.sv`）；新设计优先 XPM_CDC
5. **数据-使能对** — valid/enable 与数据成对传递；数据无效由 valid 屏蔽，**不要**靠数据通路复位清零“兜底”
6. **时钟/复位配对** — 有跨时钟域时 `i_clk_xx` / `i_rst_xx` 配对；模块若完全无复位寄存器，可不声明 `i_rst`（少见，须在模块头注释说明）

### §1.1 复位策略（对齐 UG949：数据通路少复位）

**原则：能不复位就不复位；必须复位时才用同步高有效 `i_rst`。**

| 类别 | 复位？ | 说明 |
|:-----|:------|:-----|
| FSM 状态、valid/ready/enable 控制链 | **必须** | 上电/错误恢复依赖已知控制态 |
| 计数器、FIFO 指针、配置/状态寄存器 | **必须** | 位置/配置错误通常无法自恢复 |
| **纯数据流水寄存器** | **推荐不加** | 无效数据由 valid 屏蔽；少复位 → 控制集少、打包好、利于 Fmax |
| BRAM 读数据/输出寄存器、DSP 内部流水、SRL 中间级 | **禁止加**（豁免） | 加复位阻断宏吸收；见 §10.2 / `vivado-synthesis-ug901.md` §5.1 |

- **[SHOULD]** 数据通路默认无复位；审查时把“数据寄存器顺手加 `if (i_rst)`”视为应删项，除非有书面理由  
- **[MUST]** 豁免场景须注释 `// [复位豁免] …` 且综合后用 `report_utilization` 验证宏仍被推断  
- 模板：`references/reset-templates.md`；方法学细节：`ug949-rtl-methodology.md` §2–§3

### §1.2 `initial` 用法（对齐 UG901，仅 RAM/ROM）

| 允许 | 禁止 |
|:-----|:-----|
| 对 **存储器阵列**（`logic [W-1:0] mem [0:D-1]`）在 `initial` 中赋常量/`$readmemh`/`$readmemb` | 对标量/向量寄存器、FSM、指针、valid 做 `initial` |
| 上电配置位流初值（FPGA）；初值 **≠** 运行时复位 | 用 `initial` 代替 `i_rst`；ASIC 目标依赖 `initial` |
| UltraRAM：通常 **不支持** 上电初值 → 勿对 URAM 写 `initial` 期望生效 | 带运行时条件的 `initial` 逻辑（易被 Vivado `[Synth 8-6896]` 整块丢弃） |

```systemverilog
// ✅ 允许：ROM/RAM 阵列上电初值（UG901 标准可综合写法）
(* rom_style = "block" *) logic [15:0] r_rom_array [0:255];
initial begin
  $readmemh("rom.hex", r_rom_array);
end

// ❌ 禁止：给 FF / 控制寄存器 initial（仿真-综合差异；门禁 G-C-03 FAIL）
// initial r_state = P_IDLE;
// initial ro_valid = 1'b0;
```

- **[MUST]** 阵列-only `initial` 仍须综合日志确认无 `[Synth 8-6896]`（初值被采纳）  
- 细则与反例：`references/vivado-synthesis-ug901.md` §1.4、§2.3

## §2 命名规范

### 前缀
- `i_` 模块输入 / `o_` 模块输出 / `ri_` 寄存输入 / `ro_` 寄存输出
- `r_` 内部寄存器 / `w_` 内部连线 / `P_` 参数/状态
- 时钟 `i_clk_xx`、复位 `i_rst`、跨时钟域 `_cdc`、数组 `_array`

### 例外
标准总线（AXI/Wishbone/JTAG）保持协议原名，不受前缀约束。

## §3 代码结构
```
模块声明 → 参数/P_ → 输入寄存/ri_ → 输出寄存/ro_ → 例化 → 状态机 → 组合逻辑 → 时序逻辑 → 数组
```
- 每模块 ≤300 行，每 always ≤50 行，控制/数据通路分离

## §4 状态机
- **[MUST]** 三段式（状态跳转 + 次态判断 + 输出），`localparam` 定义，`default` 必写
- 编码：≤5→二进制, 5~50→独热, >50→格雷（模板: `references/fsm-templates.md`）

## §5 位宽与符号（向 UG901 靠齐）
- 左右位宽必须匹配；有符号运算操作数 **同为 signed**，禁止有/无符号混算
- 乘法器输出位宽 = 输入位宽之和；加法注意进位位
- 截位/扩展必须显式：`$signed`/`$unsigned` 或按位拼接，禁止依赖工具隐式扩展
- `for` 循环仅用于 **可静态展开** 的 generate/组合描述；运行时可变界循环不可综合

## §6 阻塞/非阻塞
- 时序逻辑 @posedge clk → `<=`，组合逻辑 → `=`
- **[MUST]** 禁止混用同一 always
- **[SHOULD]** 优先 `always_ff` / `always_comb`（意图清晰，利于审查）；禁用 `always_latch`

## §6.1 case / 控制流（UG901 薄弱项补齐）
- **[MUST]** 组合 `case` 必有 `default`（红线 5）
- **[SHOULD]** 不需要优先级时用 `case` 而非长 `if-else` 链（平坦 MUX，利于面积/时序）
- **[MUST]** 综合 RTL **禁用 `casex`**（X 参与匹配 → 仿真/综合语义陷阱）
- **[SHOULD]** 慎用 `casez`；掩码意图写清楚；优先 `unique case` / 完整枚举 + `default`
- 计数器：同步计数 + 同步复位（控制类）；溢出/回绕行为必须在注释与 TB 中固定

## §7 工具使用与验证
- **[SHOULD]** lint：提交前 `make lint` 通过（lint 检查基础语法，但不检查锁存器/命名等关键问题，不可替代人工审查）
- **[MUST]** 仿真：模块级功能仿真通过后再提交
- **[MUST]** 仿真报错按顺序排查：先检查端口位宽匹配，再查时序，最后查逻辑
- **[SHOULD]** RTL 输出必须与 Golden Model bit-true 对齐，不允许用容差掩盖算法偏离
- **[MUST]** 综合级结论（资源够不够 / 时序收不收敛 / 推断成没成功 / CDC 干不干净）**必须有 Vivado 报告支撑**，见 §10。无 EDA 环境时写"未验证"，不得把静态推断写成结论
- **[MUST]** 含阵列 `initial` 的模块：综合后检查无 `[Synth 8-6896]`，且利用率中 ROM/RAM 映射符合预期

---

## §8 锁存器预防（红线 5 的排查法）

**为什么重要**：锁存器在 FPGA 中不会在 lint 报错，但会导致时序异常和功能随机失败——是最难调试的 bug 之一。大多数"仿真对了但上板不对"的案例，根因是组合逻辑推了 latch。

### 三段排查法

```
排查锁存器三步走：
1. always_comb 中所有分支都赋值了吗？→ if 要有 else，case 要有 default
2. 组合逻辑中读取的信号同时被赋值了吗？→ 那是组合反馈环
3. 某个信号只在特定条件下保持值？→ 一定推了 latch
```

### 典型违规模式

| 模式 | 代码片段 | 问题 |
|:-----|:---------|:-----|
| 缺 else | `if (cond) q = 1;` | `cond=0` 时 q 保持 → latch |
| 缺 default | `case(s) A: q=1; B: q=0; endcase` | 未覆盖分支 q 保持 → latch |
| 状态未全覆盖 | `case(s) IDLE: q=d; BUSY: q=q+1; endcase` | DONE 状态未覆盖 → latch |
| 组合反馈 | `always @(*) q = q + 1;` | 不经过触发器的组合环 → 震荡 |
| 自读自写 | `always @(*) result = result + data;` | 同一变量组合自指 → 环路 |

### 检查清单
- [ ] 每个 `always @(*)` 都有完整的条件分支（if→else, case→default）
- [ ] 组合逻辑中不存在信号自读自写？→ 有则改为时序 `<=`
- [ ] 组合 case 覆盖了所有可能的状态值？
- [ ] 输出端口由 ro_ 时序驱动，非组合逻辑直出？

---

## §9 工作流程
- **[SHOULD]** 新模块、架构级改动或跨模块任务：实施前先输出执行计划，与用户对齐后再编码
- 已有文件中行为明确的小修复：直接做范围内最小修改，无需计划确认（与 CLAUDE.md 授权边界一致）

---

## §10 Vivado 综合可预测性（对齐 UG901 / UG949）

**为什么单独立一节**：红线管的是功能正确与可维护性，管不到"综合器到底把你的代码变成了什么"。
FPGA 上最贵的事故不是仿真错，是**推断静默失败**——RTL 仿真全对，综合完 BRAM 用了 0 块、
DSP 没吸收流水寄存器、Fmax 掉一半，而工具**不报任何错**。

### 10.1 三条硬要求

0. **[MUST] 查文档先锚版本。** 先用 `node engine/scripts/eda-detect.cjs --json` 查出本机
   实际版本，再把 docs.amd.com 切到同一版——它默认显示最新发行版，而本机通常落后若干版。
   照新版抄来的 TCL 选项、综合属性、器件型号，在旧版上会报 `invalid option`、被静默忽略
   或找不到 part。UG 地图与细则见 `references/vivado-doc-map.md`。
1. **[MUST] 不跑工具不下综合结论。** 没有 `report_utilization` 不许说"资源够用"；没有
   `report_timing_summary` 不许说"时序能收敛"；没有 `report_cdc` 不许说"CDC 没问题"。
2. **[MUST] RTL 改动后跑一次 RTL DRC**（秒级）：
   ```bash
   vivado -mode batch -nojournal -nolog \
     -source skills/vivado-flow/scripts/vivado_flow.tcl \
     -tclargs -top <top> -part <part> -src 01_src/00_hdl -out 04_prj -to rtlcheck
   ```
   → 读 `04_prj/rpt/flow_summary.json`，`ok: false` **阻断**。
3. **[MUST] 顶层集成后跑到综合**：同一脚本 `-from rtlcheck -to synth`（加 `-xdc 03_xdc`）
   → 仍读 `flow_summary.json`；`synth` 段的 methodology/CDC critical > 0 或 `wns < 0` **阻断**。
   修完后可 `-from opt -to route` 从检查点续跑，不必重综合。

> 执行入口统一在 **`vivado-flow`** 技能（`skills/vivado-flow/SKILL.md`），本技能只负责
> 「怎么写」的规则；「怎么跑、拿什么证据」看那边。

### 10.2 推断静默失败的高危写法（数据通路少复位的直接原因）

| 写法 | 后果 | 出处 |
|:-----|:-----|:-----|
| 给 BRAM 读数据/输出寄存器加复位 | 输出寄存器吸收失败 → Fmax 崩 | UG949 Know What You Infer |
| BRAM 输出寄存器多扇出 | 同上 | 同上 |
| 给 DSP 内部流水寄存器加复位 | MREG/PREG 吸收失败 → DSP 跑不满频率 | 同上 |
| 给移位链/延时线加复位或取中间抽头 | SRL 掉成 FF 链，面积膨胀数十倍 | 同上 |
| 纯数据流水寄存器滥加复位 | 控制集膨胀 → FF 打包差、面积虚高 | UG949 Control Sets |

→ BRAM/DSP/SRL 是红线 3 的**硬豁免场景**（必须不复位 + 注释 + 报告验证）。  
→ 一般数据通路是 **推荐不复位**（§1.1），不是“禁止复位”，但默认写法应为无复位。  
细则：`references/vivado-synthesis-ug901.md` §5 / §5.1。

### 10.3 还必须知道的几件事

- **门控时钟是禁止写法**：用 BUFGCE 的时钟使能，不写 `always @(posedge (clk & en))`
- **控制集**：数据通路少复位 + 合并 CE；`report_control_sets` 查打包
- **优先用 XPM_CDC 宏**而不是手写同步器：`report_cdc` 能识别、内置 `ASYNC_REG`
- **`report_timing_summary` 必带 `-report_unconstrained`**：未约束路径是最常见的假绿灯
- **`initial` 只服务 RAM/ROM 阵列初值**（§1.2）；标量 initial = 仿真-综合差异
- 官方推断模板：Vivado IDE → Language Templates；抄完必须改成 `ri_`/`ro_` 与本仓库复位策略

### 10.4 属性使用纪律

综合属性（`RAM_STYLE` / `USE_DSP` / `MAX_FANOUT` / `DONT_TOUCH` / `ASYNC_REG` …）是对综合器的
**强制指令**：

- **[MUST]** 每个属性旁写一行注释说明为什么加 —— 无注释的属性没人敢删，会长期锁死过时决策
- **[MUST]** 加完属性必须用报告验证它生效 —— 名字/取值写错时 Vivado 只 warning 甚至静默忽略
- **[SHOULD]** 优先改代码结构，属性是最后手段

完整属性表见 `references/vivado-synthesis-ug901.md` §4。

---

## 参考文件
`skills/hdl-coding/references/` 下按需读取：

| 主题 | 文件 |
|:-----|:-----|
| 代码对齐细则 / LUT 映射门禁 | `RTL_DESIGN_RULE.md` |
| 三段式状态机模板 | `fsm-templates.md` |
| 流水线设计模板 | `pipeline-templates.md` |
| 存储器建模 | `memory-templates.md` |
| 异步复位同步释放 | `reset-templates.md` |
| Testbench 结构模板 | `tb-templates.md` |
| TB 记分板 + AXI-Stream VIP | `tb-scoreboard.md`（配套 `axi_stream_if.sv`、`axi-stream-vip.sv`） |
| 功能覆盖率模板 | `coverage-templates.md` |
| 时序约束（时钟/IO/例外） | `timing-constraints.md` |
| **Vivado 语言级：可综合子集 / 推断模板 / 综合属性（UG901）** | `vivado-synthesis-ug901.md` |
| **Vivado 方法学：层次/控制集/复位/Know What You Infer/Fmax/功耗/CDC（UG949）** | `ug949-rtl-methodology.md` |
| **Vivado 工具流：RTL DRC / report_* / 非工程模式 TCL / xsim** | `vivado-tool-flow.md` |
| **Vivado 文档导航：哪本 UG 管哪件事 + 查文档前的版本锚定** | `vivado-doc-map.md` |
| 资源与时序优化 | `fpga-optimization.md` |
| FPGA 开发流程与最佳实践 | `fpga-development.md` / `design-best-practices.md` |
| 除法器/LUT 技巧 | `division-lut.md` |
| RTL 审查清单 | `rtl-code-review.md` |
| 算法→Verilog 参考 | `alg-flow-verilog.md` |
| ALU/加法器设计 | `alu-design.md` |
| 常用算法硬件实现（CRC/哈希/CAM…） | `algorithm-hardware.md` |
| 注释规范 / 代码简化 | `comment-standards.md` / `simplification-guide.md` |

## 代码模板
`skills/hdl-coding/templates/` 下按域组织：

| 目录 | 状态 | 使用方式 |
|:-----|:-----|:---------|
| `comm/`（9 个：AXIS 主/从/流水寄存、CDC、复数乘、LFSR、延迟链、双口 RAM） | **符合本规范**（ri_/ro_/r_ 命名、元数据头） | 可直接例化或改造 |
| `alu/`（3 个）、`internet/`（8 个：CRC/哈希/LRU/CAM/帧同步/Crossbar/SM4） | **外部资料改编**，命名未按 ri_/ro_ 规范 | 仅参考算法结构；复用前必须按 §1/§2 重写接口与命名 |

> Vivado 执行脚本不在本技能内 —— 见 `vivado-flow` 技能的
> `skills/vivado-flow/scripts/vivado_flow.tcl`（本技能原先的 `templates/tcl/` 两个脚本是它的子集，
> 2026-07-27 已删除以避免两套入口漂移）。

## 关联 Skill
- [code-review](../code-review/SKILL.md) — 代码审查
- [debugging](../debugging/SKILL.md) — 仿真调试
