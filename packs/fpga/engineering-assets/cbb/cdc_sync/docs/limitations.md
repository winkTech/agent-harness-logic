# cdc_sync — 已知限制（1.0.0）

以下各条来自实测与设计裁决，非推测；验证证据见
`engineering-assets/evidence/cdc_sync/1.0.0/`（含 **Vivado `report_cdc` 实跑**
的 `cdc-report.json` 与 `cdc.rpt`）。

1. **亚稳态无法被证明（最重要的一条）**：仿真与综合报告都不能证明亚稳态收敛。
   本 TB 只证**协议功能正确**（握手不丢不重、valid 单拍脉冲、电平转变有序、
   计数守恒）。结构安全性由三件事承担：RTL 的 `(*ASYNC_REG*)` 属性（使同步链
   落在同一 slice，缩短级间走线以提高 MTBF）+ XDC 的
   `set_max_delay -datapath_only`（限制跨域走线延迟）+ `P_STAGES ≥ 2` 的编译期
   约束。**MTBF 的定量计算需器件失效率数据，不在本次取证范围内。**

2. **两域必须联合复位**：运行中单域复位**不在契约内** —— req/ack 相位会失配，
   导致永久死锁（ready 再不置位）或重复传输。集成方必须保证两域复位同时生效
   或有明确先后约定。

3. **多比特路径吞吐受握手往返约束**：一次传输约
   `(P_STAGES+1)` 个 dst 拍 + `(P_STAGES+1)` 个 src 拍。面向**低速控制字/状态
   传递**。**高吞吐跨域请用异步 FIFO，不要用本模块。**

4. **单比特路径是电平语义，不是脉冲语义**：电平必须保持
   **≥ 2 × P_STAGES 个目的域拍**才保证被观察到。直接传单拍脉冲会丢。

5. **`report_cdc` 的 8 条 CDC-15 Warning 是预期形态，已如实保留**：数据总线
   （`ri_data_src → ro_data_dst`）刻意不加同步器 —— 加了反而会因各位收敛时刻
   不同而**撕裂**。安全性由协议承担：数据在 req 翻转前锁定；dst 侧只在 req 经
   2 级同步链传播到位后捕获（此时数据已稳定 ≥ P_STAGES 个目的域周期）；
   `o_ready_src` 保证握手在途期间源侧不改数据。Vivado 无法验证协议故判 Warning，
   **本资产不对该 Warning 做豁免、不声称 CDC clean**。

6. **约束不可替换为 `set_clock_groups -asynchronous`**：那会让工具完全忽略跨域
   路径，连数据通路延迟都不再约束，源寄存器到同步链首级的走线可以任意长，
   一旦超过目的域一个周期就破坏同步器的收敛前提。必须沿用
   `set_max_delay -datapath_only`。

7. **与旧模板不兼容（breaking）**：改写自
   `skills/hdl-coding/templates/comm/cdc_sync.sv` v1.0.0。原件 5 条缺陷：
   `o_valid_dst` 组合直出且把复位当数据用、多拍电平非脉冲（下游无法区分一次与
   多次传输）、src 域不锁数据（握手期间改数据即静默出错）、无 `o_ready_src`
   （握手中再来 valid 被静默丢弃）、同步链无 `(*ASYNC_REG*)` 属性（把安全性
   外包给使用者）。逐条记录在 RTL 模块头。

8. **综合口径**：OOC（`xc7k325tffg900-2`），两域异频 src 100 MHz / dst 150 MHz，
   未做布局布线与 I/O 绑定。实测 FF 24 与结构推算 24 完全吻合。参数
   `P_DWIDTH=8` / `P_STAGES=2`；更大位宽会线性增加数据寄存器与 CDC-15 条目数，
   但不改变结构安全论证。

9. **工具链**：仿真证据由 **Vivado xsim 2023.1** 产出（本机 ModelSim 回环 RPC
   故障）；CDC 证据由 **Vivado 2023.1 `report_cdc`** 产出；`vlog` 编译不受影响，
   门禁 G-A-00 仍由 ModelSim 判读。
