# delay_line — 已知限制（1.0.0）

以下各条来自实测与设计裁决，非推测；验证证据见
`engineering-assets/evidence/delay_line/1.0.0/`。

1. **数据链刻意不复位**：`ri_data` / `r_data_pipe` / `ro_data` 不受 `i_rst`
   控制。这是显式设计决策 —— 省复位扇出并让综合器推断 SRL 移位寄存器。
   复位后数据链**保留旧值**，其无害性由 valid 门控保证：复位清 valid 链，
   旧数据不会被标记为有效。逐寄存器复位审计因此只覆盖 valid 链，该豁免写入
   `reset-sim.json` 的 `method` 字段。**若集成方需要复位后数据链归零（如安全
   相关场景），本模块不满足。**

2. **无反压接口（设计裁决）**：定长延迟与背压是**正交职责**。需要背压时在
   **输出侧**例化已认证的 `axis_skid_buffer`；不要在本模块内加 ready ——
   那正是旧 `pipe_delay` 模板出错的地方。G-C-05 的 backpressure 子结果按
   「计数守恒 + 延迟恒为 `P_DELAY` 拍且与气泡图样无关」的等价判据取证。

3. **`P_DELAY` 最小为 2**：输入寄存与输出寄存各占一级（红线 1/2 要求）。
   `P_DELAY < 2` 由编译期 `$error` 拦截。

4. **SRL 推断的取证边界**：默认参数 `P_DELAY=2` 时 `P_MID=0`，**没有中间移位
   链，故综合实测 SRL = 0 属预期，不能据此判定推断失败**。`P_DELAY > 2` 时的
   SRL 映射未单独取综合证据 —— 需要该配置的集成方应自行复核 `LUT as Shift
   Register` 是否如期出现。

5. **参数取证边界**：综合与资源预算按默认 `P_DWIDTH=32` / `P_DELAY=2` 评估。
   功能侧另以 `P_DELAY=7` 例化并行验证（含 5 级中间链）。其他参数组合需重新
   评估资源与时序。

6. **取代旧模板（breaking）**：取代 `skills/hdl-coding/templates/comm/` 下
   `pipe_delay.sv`（`o_ready` 组合直出违反红线 2；各级共用末级 advance 是全局
   停顿而非逐级吸收，中间气泡无法压缩；复位清数据链阻止 SRL 推断）与
   `delay_sync.v`（端口无 `i_`/`o_` 前缀、无 valid 语义、复位清数据链）。
   逐条记录在 RTL 模块头。

7. **综合口径**：WNS/资源来自 **OOC 综合**（`xc7k325tffg900-2`，仅
   `create_clock`），未做布局布线与 I/O 绑定。实测 FF 66 与结构推算 66 完全
   吻合（数据 2 级 × 32 + valid 2）。

8. **工具链**：本版全部仿真证据由 **Vivado xsim 2023.1** 产出（本机 ModelSim
   回环 RPC 故障）；`vlog` 编译不受影响，门禁 G-A-00 仍由 ModelSim 判读。
