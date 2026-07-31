# channel_est_top — 已知限制（0.2.1）

以下各条来自实测与设计决策，非推测；对应验证证据见
`var/gates/pg/channel_est_top/` 与 README「验证现状」。

1. **定点语义镜像耦合**：RTL（`lts_estimator` / `cpe_tracker` /
   `cpe_rotate_out` / `cordic_cv` 头注释）与 golden 的
   `src/generate_vectors.m` 位真镜像必须逐字同步——LTS 平均 +1 舍入、
   S 累加 `>>>14` 截取、CORDIC 常数表（atan Q3.13 / PI=25736 / K=9949）、
   round+饱和。任何一侧改动定点语义而不同步另一侧，cosim 即失配。
2. **导频极性为固定 [1,1,-1,1]**（golden `sim_frame.m` 契约）：802.11a
   规定的逐符号导频扰码序列未建模。golden 升级扰码时 RTL 须同步
   （需求门禁 D6 已记录，不阻塞当前验收）。
3. **i_frame_start 时序契约**：脉冲须领先首个 LTS 样点 ≥1 拍；与样点同拍
   到达的 beat 归属旧流。上游（sync_top 类）天然满足；直连其他源时需注意。
4. **节流行为**：帧起始待决而输出未排空、或数据符号末 3 拍且 CPE 链未闲时,
   `s_axis_tready` 拉低（AXIS 合法）。持续 80 拍符号间隔（含 CP）下无节流;
   背靠背 64 拍流会在符号尾停顿数拍。上游须容忍 tready 变化。
5. **UVM 环境断链**（承自 0.1.0）：`tb/uvm/` 引用的模板相对路径在本包内
   不存在，按原样不可编译。判卷不依赖 UVM（定向 TB + cosim 承担），
   保留待后续接线。
6. **CORDIC 精度**：14 迭代，角度量化 ≈1.2e-4 rad；对验收指标（CPE 误差
   门限 0.1 rad）裕量 ~3 个数量级，但不适用于需要更高相位精度的场景。
7. **单时钟域**：无 CDC 逻辑；`cdc-report.json` 以结构扫描出具
   （cdc_tool=na），跨时钟集成时须外部处理。
