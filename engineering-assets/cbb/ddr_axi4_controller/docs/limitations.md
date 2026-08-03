# ddr_axi4_controller — 已知限制（1.0.0）

以下各条来自实测与设计裁决，非推测；验证证据见
`engineering-assets/evidence/ddr_axi4_controller/1.0.0/`。

1. **超时时撤回已置位的 AXI valid —— 严格 AXI 不允许**：`P_TIMEOUT` 拍无进展时
   本模块会撤掉 AW/AR/W 的 valid 并回 IDLE。这是**刻意的 MIG 挂死恢复路径**，
   但违反 AXI 的"valid 一旦置位必须保持到 ready"规则。接入严格校验的 AXI
   检查器或互连时可能被判违规 —— 集成方需评估是否可接受，或把 `P_TIMEOUT`
   设得足够大使其实际不触发。

2. **单 ID 单事务顺序执行**：无流水、无乱序、无多 outstanding。吞吐受"一次
   事务完整走完"约束，不适合需要高 outstanding 深度的高带宽场景。

3. **`o_rd_*` 无背压**：读数据流没有 ready。下游必须能无条件接收；需要背压时
   在下游例化已认证的 `axis_skid_buffer`。

4. **复位丢弃在途事务**：复位会中途放弃 AXI 事务（从机侧看到的是事务被丢弃）。
   **须系统级复位，正常运行中不得复位**。

5. **未与真实 MIG 联调**：全部验证针对 TB 内的 AXI4 从机行为模型。真实 MIG 的
   时序特性（初始化延迟、刷新导致的长停顿、地址映射约束）未覆盖。
   `i_calib_done` 门控已验证（未置位期间 `o_cmd_ready` 保持低）。

6. **参数取证边界**：综合与资源预算按默认 `P_DATA_W=512` 评估；功能侧以
   `DW=64` / `TB_MAX_LEN=16` / `TIMEOUT=256` 取证。`P_MAX_LEN=256` 的极限突发
   未做功能验证。

7. **TB 竞争缺陷的历史记录（重要，防回退）**：本模块的自检 TB 曾因**在 posedge
   之后用阻塞赋值驱动 R 通道**而与 DUT 的 `always_ff @(posedge)` 竞争，表现为
   `rd_last` 错位与读数据移位一拍，**误报为 RTL 缺陷**。修复方式是把从机的
   R 通道驱动统一移到 negedge，TB 内已注明原因。**后续任何人改这个 TB 都不要
   把驱动移回 posedge。**

8. **综合口径**：OOC（`xc7k325tffg900-2`，仅 `create_clock`），未做布局布线与
   I/O 绑定。实测 FF 1619 与结构推算 1616 相差 3。

9. **工具链**：本版全部仿真证据由 **Vivado xsim 2023.1** 产出（本机 ModelSim
   回环 RPC 故障）；`vlog` 编译不受影响，门禁 G-A-00 仍由 ModelSim 判读。
