# frame_sync — 已知限制（1.0.0）

以下各条来自实测与语义约定，非推测；验证证据见
`engineering-assets/evidence/frame_sync/1.0.0/`。

1. **`i_valid` 是载波有效，不是可气泡的流 valid**（最容易误用的一条）：
   语义等同 GMII `rx_dv` —— **帧内必须连续，拉低即帧尾**。若把带气泡的
   AXI-Stream valid 直接接进来，每个气泡都会被当成帧尾，帧被切碎。需要气泡
   语义的集成方**必须在上游先做流适配**（如用 `axis_skid_buffer` 聚流或自行
   加载波保持逻辑）。

2. **FCS 不剥除**：定界器不做 store-and-forward，无法在帧尾回溯剥除末 4 字节。
   前导与 SFD 被剥除、不出现在输出流；FCS 原样透传。需要剥 FCS 的场景可组合
   `delay_line`（延迟 4 字节）+ `crc32`（校验）实现。

3. **零长帧退化**：SFD 后立即掉载波时，只出 `o_eof` 不出 `o_sof`。下游必须按
   此约定处理（不能假设 eof 一定有配对的 sof）。

4. **抗噪能力由 `P_MIN_PREAMBLE` 决定**：默认 2。该阈值是**真正参与 SFD 判定**
   的（原模板此计数是死寄存器，单个 `0x55`+`0xD5` 即成帧，抗噪为零）。阈值越大
   抗噪越强但对短前导帧越不友好；实际链路应按 IEEE 802.3 的 7 字节前导留裕量。

5. **无反压接口**：输入为载波流，输出为定长 2 拍延迟，均无 ready。G-C-05 的
   backpressure 子结果按「帧间载波间隙 0..4 拍随机变化下帧定界结果不变」的等价
   判据取证。

6. **与旧模板不兼容（breaking）**：改写自
   `skills/hdl-coding/templates/internet/frame_sync.v` v1.0.0。原件 5 条缺陷：
   前导计数是死寄存器（抗噪为零）、不透传数据且指示相位未定义、单 always 混合
   状态与输出违反三段式且输入未寄存、`P_ST_CRC` 状态无意义、`o_frame_valid`
   在无数据语义的 sof 拍置位。逐条记录在 RTL 模块头。

7. **综合口径**：WNS/资源来自 **OOC 综合**（`xc7k325tffg900-2`，仅
   `create_clock`），未做布局布线与 I/O 绑定。实测 FF 27 与结构推算 27 完全
   吻合。综合与预算按 `P_MIN_PREAMBLE=2` 评估。

8. **工具链**：本版全部仿真证据由 **Vivado xsim 2023.1** 产出（本机 ModelSim
   回环 RPC 故障）；`vlog` 编译不受影响，门禁 G-A-00 仍由 ModelSim 判读。
