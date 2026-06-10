# Phase 3: TB + MATLAB 向量生成

> 所属工作流: `workflows/hdl-coding-workflow.md`
> 目标: 先写能自动判断对错的 testbench，并生成 MATLAB golden 测试向量，再写 RTL。

## 3.1 比对策略选定

根据模块特性选择比对模式，解决 RTL 与参考模型之间的时序差异：

| 模式 | 适用场景 | 说明 |
|:-----|:---------|:------|
| **周期精确** | 组合逻辑、固定延迟流水线 | 逐 cycle 比对 `dout === expected`。参考模型输出每 cycle 预期值 |
| **事务级** | 有握手/反压的模块 | 比对事务内容与顺序，忽略具体 timing。用 `mailbox`/`queue` 缓存后比对 |
| **Scoreboard 累计** | 无序输出、多通道聚合 | 累积所有输出总量，结束时一次性比对 |

选定策略后在 `compare_mode` 参数中记录。建议跨 cycle 关系用 SVA `##[min:max]` 约束，不要硬编码固定延迟。

## 3.2 自检 Testbench 模板

```systemverilog
module tb_module;
  // 时钟/复位生成
  // DUT 例化
  // 激励产生（从测试向量文件读取）
  // 预期输出加载（从 MATLAB golden 向量读取）

  integer cycle_count;
  always @(posedge clk) begin
    if (compare_enable) begin
      if (dout !== expected_dout) begin
        $display("[FAIL] cycle=%0d dout=%h expected=%h",
                 cycle_count, dout, expected_dout);
        error_count++;
      end else begin
        $display("[PASS] cycle=%0d dout=%h", cycle_count, dout);
      end
      cycle_count++;
    end
  end

  initial begin
    $display("=== Test Start ===");
    // 加载测试向量 → 驱动 DUT → 比对 golden
    #1000;
    $display("=== Test End: %0d errors ===", error_count);
    $finish;
  end
endmodule
```

## 3.3 MATLAB Golden 测试向量生成

每个子模块必须生成对应的 MATLAB golden 参考向量，存入 `02_sim/tv/` 目录：

```
02_sim/tv/
├── scrambler_tv.txt      # scrambler.m 输出 → 预期值
├── interleaver_tv.txt    # interleaver.m 输出 → 预期值
├── modulator_tv.txt      # modulator.m Q16.9 星座点
├── equalizer_tv.txt      # equalizerOfdm.m 输出 → H_est/Y_eq
└── ...
```

**向量文件格式规范：**
```
# <模块名> golden test vectors
# source: <对应的 MATLAB 文件.m>
# format: <每行含义>
cycle=0000  din=0xXX  dout=0xXX  expected=0xXX
cycle=0001  din=0xXX  dout=0xXX  expected=0xXX
...
```

**[MUST] 标准算法模块（LFSR/Viterbi/CRC/FIR/卷积码）：**
- 必须用 MATLAB 官方工具生成黄金参考向量
- **禁止自闭环验证**（编码→译码对比），因为编解码器可能有一致性偏差导致互验通过但实际都错
- 参考向量存入 `02_sim/tv/` 目录，TB 直接读取对比

## 3.4 SVA 断言嵌入

```systemverilog
// 每个关键属性都作为仿真时的实时检查点
assert property (@(posedge clk) valid |-> ##[1:3] ready);
assert property (@(posedge clk) fifo_full |-> !fifo_wr);
```

## 3.5 TB/向量生成器耦合检查

涉及帧结构（多子帧拼接、变调制格式、变位宽）的 testbench，必须增加检查：

- **帧参数一致性**：TB 中的 `n_in_bytes` / `n_out_syms` 必须与向量生成脚本的计算值一致
- **驱动偏移正确性**：多子帧场景的 `offset` 参数必须与向量生成器的数据排列顺序对应
- **符号计数断言**：TB 应包含帧长断言，当实际输出符号数 != 预期符号数时及早报错而非静默超时
- **自检过杀保护**：全星座点测试中，帧尾 tlast 检查需区分"子帧自然结束"和"帧尾漏报"

## 3.6 结构化日志宏

```systemverilog
`define LOG(lvl, msg) \
  $display("[%t] [%s] %s", $time, lvl, msg)

// 使用
`LOG("PHASE", "Layer 0: 端口连通性测试")
`LOG("CHECK", "data_in=%h data_out=%h", din, dout)
`LOG("PASS", "FIFO 读写测试通过")
`LOG("FAIL", "状态机预期状态=%s 实际=%s", EXPECTED, current)
```

## 检查点

- testbench 编译通过，自检逻辑完整，SVA 无编译错误
- MATLAB golden 测试向量已生成，存入 `02_sim/tv/`
- 标准算法模块已生成黄金参考，未使用自闭环验证

**关联 Skill**: `hdl-coding`（Testbench 结构模板、SVA 编写参考）
**数据输入**: `.claude/state/hdl-coding/project-spec.json`（Phase 1 输出，含端口列表和比对策略）

**可执行检查点**:
```bash
source .claude/checkpoints/hdl-checkpoints.sh && check_phase_3
```
