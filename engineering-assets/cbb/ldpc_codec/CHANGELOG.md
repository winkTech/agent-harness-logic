# CHANGELOG — ldpc_codec

## [1.0.3] — 2026-08-02 声明证据复现入口（G-GATE-02）

manifest 新增 `reproduce` 字段，把"证据怎么重做"从 README 里的散文变成**机器可校验
的契约**。新门 `G-GATE-02` 校验该命令引用的脚本在仓库中真实存在。

动因：`G-GATE-01` 只查证据文件在不在，普查发现 16 个 certified 里 14 个的证据当时
无法被任何人重新生成，**却全都通过了 G-GATE-01**。

RTL、约束、TB、证据零改动；升 patch 版仅因 manifest 内容变化会使快照的
`manifest_sha256` 失配，按库内既定做法升版重取。

## [1.0.2] — 2026-08-02 补 xsim 复现通路；修 TB 的"失败读作通过"

**RTL 零改动。** 已安装的 certified 证据保持 ModelSim 版本不变（见下方"一处未决"）。

### 补 `run_xsim.sh`

ModelSim 回环 RPC 自 2026-08-01 起故障，`run_sim.do` 跑不通，本资产 certified
证据无法复现。现补 xsim 通路，覆盖译码器与编码器两个顶层。

xsim 复跑结果（对照 ModelSim 时代的记录）：

| 证据 | 结果 |
|:---|:---|
| `alignment-report.json` | 内容一致（译码 **10 组 / 3240 bit 0 失配**），仅 `tool` 字段不同 |
| `stability/` 四项 | **逐字节相同** |
| 编码器 bit-true | **5/5，各 0/648 失配** |
| `reset-sim.json` | **有差异** —— 26 个寄存器中 1 个，见下 |

### 修掉 TB 的"失败读作通过"（本版最重要的一条）

`tb_ldpc_decoder_top.v` 的失败路径一律用 `$finish(1)`，包括最终判决：

```verilog
end else begin
    $display("=== BIT-TRUE FAIL ===");
    $finish(1);      // ← 失败也以 0 退出
end
```

**`$finish(N)` 的 N 是诊断详略等级（IEEE 1364/1800），不是进程退出码** ——
失败 run 照样以 0 退出，上游脚本/CI 会把它读成通过。本包 README 早在 2026-07-28
就为**编码器** TB 记过这个坑（"此前没被发现的原因：TB 的 `$finish(n_fail ? 1 : 0)`
用错了"），但**译码器 TB 一直没跟着修**。8 处失败路径全部改为 `$fatal(1, ...)`。

这次改动立刻见效：xsim 首跑就以非零码终止并报出下面那处复位差异——
换作改之前，它会静静地以 0 退出。

### 一处未决：`cn_update.ro_lr` 在 xsim 下复位检查读到 X

`run_reset_check` 的采样时刻是**复位释放后 +1 拍**，那时 `ro_lr` 已经装载功能值
`w_lr` 而非复位值；`w_lr` 溯源到未初始化的 `msg_buffer`，xsim 给 X，ModelSim 给 0。
26 个寄存器里只有它这样，因为只有它由存储器阵列喂。

**安全性论证**：`msg_buffer` 的写使能是 `w_msg_wr_en = w_clear_en | w_cn_wb_valid`，
而该时刻 `ro_wb_valid` 与控制器状态（IDLE）都已验证为复位值，**这个 X 不会被写进
任何状态**；译码 10 组 3240 bit 0 失配也从经验上印证了没有下游污染。

**未擅自改动**：把检查挪到"复位仍断言时采样"才是"逐寄存器比对复位值"的正确语义，
但那会改变全部 26 个寄存器的取证口径，属签署范围内的方法学变更，留待 owner 裁定。
在此之前**已安装的证据仍是 ModelSim 版本**，未用 xsim 结果覆盖。

### 附带

`+VEC_DIR` / `+EVID_DIR` 取不到时回落到运行目录相对（编码器 TB 原先直接 `$fatal`，
xsim 下根本跑不起来）；`tool` 字段不再写死 `"ModelSim 10.6c"`，改由运行脚本经
`sim-tool.txt` 注入。

## [1.0.1] — 2026-08-02 文档补齐（RTL / 证据零改动）

**RTL、约束、综合与仿真证据全部未动。** 本版只补文档与修正 README 中与机器事实
不符的陈述；1.0.0 的签署（`by=lihan @ 2026-07-31`）继续适用，未重新签字。

- 新增 `docs/limitations.md`（17 条），补齐 asset-audit A4 要求的第三份文档。
  条目全部锚在实测证据或治理台账上：综合顶层只覆盖 `ldpc_decoder_top`、
  BRAM 零裕量 3/3、器件归一悬案、D1 编码器输入未寄存、`h_matrix_addr` 的
  `initial` 保留理由与 `ldpc_encoder_top` 上真实发生过的同类坑、G-C-05
  四子结果的覆盖与未覆盖面、UVM 环境不构成取证、ModelSim 复现路径当前不可用。
- README 补 `<!-- asset-status: certified v1.0.1 -->` marker。
- 修正 README 三处与机器事实不符的陈述：
  - 概要表"编码算法 = 双对角回代" → **PT 列累加**（旧实现对非全零信息位
    `H·c≠0`，2026-07-31 已废弃，见下方同日条目）
  - 包结构注"`run_sim.do` 路径为源库旧布局，未改" → 同日已修
  - 门禁状态段仍指 `incubator/intake/` 旧路径 → 改为 `cbb/`
- 标题去掉"intake 评估性打包"，改为指向 certified 状态与 limitations。

**为什么是 1.0.1 而不是原地改 1.0.0**：补 `docs/limitations.md` 会让 G-DOC-04
的 `detail` 字段变化，`evidence/ldpc_codec/1.0.0/` 快照因此 34 选 1 失配。
1.0.0 是签过字的版本，其快照保留原貌不动；本版另取 `evidence/ldpc_codec/1.0.1/`。

## [1.0.0] — 2026-07-31 转正 certified

- ADR-001 accepted（方案 A 分级判据）：decoder `s_axis_llr_tready` 组合-自-寄存
  判定合规（扇入锥 = 内部寄存态，无 input 依赖），encoder tready 已寄存。
- version 0.3.0 → 1.0.0；evidence_ref 指向 `evidence/ldpc_codec/1.0.0/` 快照。
- signoff（owner: lihan）+ maturity certified；`git mv` incubator/intake → cbb/。
- 证据终态：gate-runner 18/18；decoder bit-true 3240 样点 0 失配；
  encoder bit-true 5/5（含 run_sim.do PT ROM 拷贝修复，修复前非零帧全 X 假绿风险）；
  OOC synth WNS 4.958ns @ 10ns / LUT 410 / FF 244 / BRAM 3 / DSP 0。

## 2026-07-31 — 编码器 bit-true 闭环 (PT 算法)

### 背景
按计划推进编码器 golden：`gen_encoder_test_vectors.m` 用 `ldpc_encode_80211n`
（`PT_1_2_648.mat`）导出 5 组 info/code。对照后发现旧双对角回代 RTL 对非全零
信息位 **H·c ≠ 0**（syndrome 非零），全零碰巧通过 —— 性质测试遮不住校验位错误。

### 变更
- **`ldpc_encoder_top` 重写为 PT 列累加**：`parity = PT * info`（GF2），与 MATLAB golden
  同构；ROM = `rtl/pt_columns.hex`（自 `PT_1_2_648.mat` 导出，324×324）。
- **`tb_ldpc_encoder_top`**：加载 `tb_enc_info_*.hex` / `tb_enc_code_*.hex`，bit-true 比对；
  需 `+VEC_DIR`；`+PT_MEM` 指向 PT ROM。
- **`models/comm/ldpc/gen_encoder_test_vectors.m`**：固定 seed，syndrome 自检后导出。
- **卫生**：`tb/run_sim.do` 去掉旧 `../01_rtl` 假设；`tb/uvm/compile.tcl` 指到 `package/rtl`。
- manifest **0.3.0**。

### 验证（本机 ModelSim 10.6c，2026-07-31）
- 译码器复跑：10 向量 **3240 bit 0 失配**，`BIT-TRUE PASS`；G-C-04/05 子项仍过。
- 编码器 bit-true：**5/5 PASS**（0/648 mismatch × 5）。
- gate-runner：见同次运行输出（仍卡 `G-SIGN-01` 用户签字）。

### 遗留
- D1 编码器输入 `ri_` 寄存仍未做（控制通路重构，现已有 bit-true 基线可回归）。
- PT-ROM 面积大于双对角；若需减资源，应在**保持 bit-true**前提下再做结构优化。

## 2026-07-28 — 编码器 hdl-coding 规范整改

本轮**只动 `ldpc_encoder_top`**。译码器侧（`ldpc_decoder_top` / `ldpc_controller` /
`h_matrix_addr` / `llr_buffer` / `msg_buffer` / `cn_update` / `early_term` /
`ldpc_stream_io`）在 2026-07-26 的重写中已完成红线整改并 bit-true 验证，
本轮未触碰，并已复跑回归确认未受波及。

### 变更（`ldpc_encoder_top`）

- **消除 `initial`（G-C-03 真实 fail）**：原文件两个 `initial`，其中用
  `if (p_rom[...] != 5'd31)` 扫描构建 `sys_col/sys_shf/sys_cnt` 的那个，条件依赖
  reg 数组内容，Vivado 判为非常量条件并报 `[Synth 8-6896]` **丢弃整个 initial 块**
  —— 仿真里三张表有值，综合后无驱动源（`[Synth 8-3848]`），上板行为与仿真不一致。
  这与 `h_matrix_addr.v` 里已修过的是同一个坑。现全部改为编译期 `localparam`
  扁平常量（`SYS_COL_FLAT` / `SYS_SHF_FLAT` / `SYS_CNT_FLAT` / `P_P0_12`），
  用变量基址位选 `[idx*W +: W]` 取值。
- **修复挂死**：`s_axis_info_tready` 原先在 `S_IDLE` 就为高，进 `S_LOAD` 之前那一拍
  已完成 AXI 握手把第一个信息位收走，而 `bit_cnt` 与 `info` 只在 `S_LOAD` 更新
  —— **第一位既不计数也不存储**。324 拍激励下 `bit_cnt` 最多到 322，
  `bit_cnt == K-1` 永不成立，状态机出不了 `S_LOAD`。现改为 ready 只在 `S_LOAD` 有效。
- 红线 2：`s_axis_info_tready` 由组合直出改 `ro_tready` 寄存输出。
- 红线 4/5：次态 case 补 `default` 分支。
- 命名：localparam 加 `P_` 前缀，内部寄存器加 `r_`/`w_` 前缀。

### P 矩阵常量表的生成方式

`SYS_*_FLAT` 三张表由 P 矩阵（802.11n R=1/2 Z=27）按**原 initial 里的扫描算法**
在编译前展开而来，与原实现逐条等价（生成脚本内置行重自检：最大行重 6 ≤ MAX_WT 8）。
P 矩阵原始数据（88 条非 -1 项）保留在 `models/comm/ldpc/` 的 golden 侧与本包
`h_matrix_addr.v` 中；**P 矩阵变更后必须重新展开这三张表**，否则编码器与
H 矩阵不一致。

### TB 修正（`tb_ldpc_encoder_top`）

- 收集循环原在 `@(posedge clk)` 处直接读 `m_tdata`，取到的是该边沿**之前**的旧值，
  且只看 tvalid 不看 tready，不是按握手采样。现严格按 `(tvalid && tready)` 成交采样。
  （注意：AXI-S 语义下正确的采样点就是边沿之前的总线值，不能 `#1` 越过边沿再读
  —— 那会取到 DUT 本边沿刚更新的下一拍数据。）
- 驱动侧改为在边沿判定成交、`#1` 越过边沿再换数据。
- `$finish(n_fail ? 1 : 0)` → `$fatal`。`$finish(N)` 的 N 是**诊断详略等级**不是
  进程退出码，原写法让失败与超时都以 0 退出，上游读起来全是通过。

### 验证

- **编码器**：`tb_ldpc_encoder_top` **5/5 通过**（全零码 + 4 组随机的系统码性质）。
  整改前为 1/5 —— 4 组随机用例全部挂死超时。
- **译码器 bit-true 回归（确认未受波及）**：`tb_ldpc_decoder_top` +
  `models/comm/ldpc/vectors/` 10 组向量，**每组 0/324 bit 失配，`synd_fail=0`**；
  `[G-C-04]` 稳定性 26 拍 0 抖动。
- gate-runner：`G-A-00/G-A-01/G-A-02/G-A-04/G-C-03/RL-OUT/G-B-03/G-C-01/G-C-02/
  G-C-04/G-C-05/G-GATE-01` 全绿，仅剩 `G-SIGN-01`（用户签字）与文档门。

## 2026-07-26 — 译码器控制架构重写

见 `ARCHITECTURE-GAP.md`。10 向量 3240 bit 0 失配，达 QUALIFICATION。
