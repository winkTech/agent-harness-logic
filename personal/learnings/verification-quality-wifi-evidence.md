---
name: verification-quality-wifi-evidence
description: 验证质量门禁的设计依据 — WiFi PHY 项目验证失真的 8 条教训。单元 TB 环境失真 → 集成爆炸 → agent 调试能力被突破 → 人工救火。解法：环境画像前移 + 增量集成缩短调试链。
metadata:
  type: project
  related: [[16-verification-quality-gate]] [[verification-must-be-functional]] [[fullframe-tb-frame-boundary-bug]] [[viterbi-double-traceback-fix]] [[file-variant-explosion]] [[per-module-pipeline]] [[uvm-verification-framework]]
---

# 验证质量门禁 — WiFi PHY 项目证据

**Why**: WiFi PHY 项目中，单元 TB 只验证理想条件（无背压、无帧边界 stress、无复位测试），
导致单模块全部"通过"但集成到 35 模块链路后大量 bug 暴露。
而此时 bug 已在多模块间级联放大，agent 无法独立追踪根因（context 溢出），需要大量人工调试。

**How to apply**: 编写任何 TB/验证方案前，先完成 `rules/16-verification-quality-gate.md` 的 Part A（环境画像 + 最少场景集）。
集成阶段严格按 Part B 增量阶梯，禁止直接跳全链路。

---

## 8 条验证失真教训

### 教训 1: 无背压 TB = 假阳性
**WiFi 实例**: OFDM TX TB 8 个用例全部无背压（`tready=1`）。集成时 rx_fifo 乒乓 bank 满 → 反压 → deinterleaver → viterbi 链路行为从未验证 → 全帧 TB 失败。
**泛化**: 任何带 valid/ready 握手的模块，TB 必须覆盖 4 种背压场景（随机/连续/恢复/背靠背）。
**映射**: Part A-S2（背压与流控）

### 教训 2: 帧边界语义未在单元 TB stress
**WiFi 实例**: deinterleaver 单元 TB 只测单帧 → `tlast` 按 symbol 还是按 frame 的语义问题未暴露 → 接 viterbi 后 `r_frame_bits=1` → viterbi 输出 23142 bytes。
**泛化**: 任何涉及帧/包边界的模块，单元 TB 必须覆盖连续多帧 + 最小/最大帧 + 帧间间隙。
**映射**: Part A-S3（帧/包边界）

### 教训 3: 35 模块全链路调试 = agent 能力墙
**WiFi 实例**: 全帧 TB 失败时，agent 试图同时追踪 deinterleaver → viterbi → rx_fifo 三个模块的波形 → context 溢出 → 无法定位根因 → 人工介入数小时。
**泛化**: 调试链不能超过 2-3 模块。必须先在小范围定位，再扩大。
**映射**: Part B.1（增量集成阶梯）+ B.3（隔离协议）

### 教训 4: 波形全 dump 让 agent 崩溃
**WiFi 实例**: 全链路波形 dump 所有信号 → agent 面对 500+ 信号的波形无法提取关键信息。
**泛化**: 每个模块必须暴露少量关键观测信号（FSM 状态/计数器/帧标志/FIFO 水位）。
**映射**: Part B.2（可观测性嵌入）

### 教训 5: "理想 driver" 替代了真实 neighbor
**WiFi 实例**: TB 直接用 MATLAB 向量灌入 DUT（valid 连续、格式完美），绕过了真实 neighbor（FIFO 有反压、deinterleaver 的 valid 非连续、nibble pair 格式）。
**泛化**: TB driver 必须模拟真实 neighbor 的行为特征（valid 断续、背压模式、数据格式）。
**映射**: Part A.1（邻居行为画像）

### 教训 6: 跳过 Level 1 直接 Level 3
**WiFi 实例**: deinterleaver 单元 TB 通过 → 直接连到 35 模块全链路 → tlast 语义 bug 在 deinterleaver 就错了，但在 viterbi 才暴露 → 排查范围 = 35 模块。
**泛化**: 永远先 2-3 模块小组集成，通过后再扩大。
**映射**: Part B.1（增量集成 Level 0→1→2→3）

### 教训 7: 无复位测试
**WiFi 实例**: TB 不复位或只复位一次 → 运行中复位后状态机恢复逻辑从未验证 → 集成时 FIFO 异常需要复位 → 复位后行为未知。
**泛化**: 复位测试必须覆盖：启动复位、运行中复位、帧间复位。
**映射**: Part A-S4（复位与异常）

### 教训 8: 验证方案未记录 → 不知道什么测了什么没测
**WiFi 实例**: 没有人知道 coarse_timing 的 TB 到底覆盖了哪些场景 → 8 个版本互相覆盖 → 最终不知道哪个 TB 是对的。
**泛化**: 每个模块必须有结构化的验证方案记录（场景列表 + PASS/FAIL 状态）。
**映射**: §5（记忆更新格式）
