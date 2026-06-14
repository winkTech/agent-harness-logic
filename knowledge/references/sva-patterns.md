---
title: "SVA 断言模板库"
domain: verification
tags: [sva, assertion, systemverilog, testbench]
created: 2026-06-14
updated: 2026-06-14
difficulty: intermediate
applies_to: logic-engineer
---

# SVA 断言模板库

> 覆盖最高频的验证场景。每类断言包含说明 + 模板 + 典型错误。

---

## 1. 握手协议（AXI4-Stream ready/valid）

### 1.1 valid 时 data 必须稳定

```systemverilog
property p_stable_valid_data;
    @(posedge clk) disable iff (!rst_n)
    valid |=> $stable(data);
endproperty
a_stable_valid_data: assert property(p_stable_valid_data)
    else $error("data changed while valid asserted");
```

### 1.2 ready/valid 握手完成

```systemverilog
property p_handshake_complete;
    @(posedge clk) disable iff (!rst_n)
    ready && valid |-> ##[1:$] ready || !valid;
endproperty
```

### 1.3 ready 退耦：valid 不能依赖 ready

```systemverilog
// valid 一旦拉高，必须保持直到 ready=1
property p_valid_until_ready;
    @(posedge clk) disable iff (!rst_n)
    valid && !ready |=> valid;
endproperty
a_valid_until_ready: assert property(p_valid_until_ready)
    else $error("valid dropped before ready");
```

---

## 2. FIFO 满空

### 2.1 满时不能写

```systemverilog
property p_no_write_when_full;
    @(posedge clk) disable iff (!rst_n)
    full |-> !wr_en;
endproperty
a_no_write_when_full: assert property(p_no_write_when_full)
    else $error("write when FIFO full");
```

### 2.2 空时不能读

```systemverilog
property p_no_read_when_empty;
    @(posedge clk) disable iff (!rst_n)
    empty |-> !rd_en;
endproperty
a_no_read_when_empty: assert property(p_no_read_when_empty)
    else $error("read when FIFO empty");
```

### 2.3 深度保证（不会溢出）

```systemverilog
// 确保 wr_cnt - rd_cnt ≤ FIFO_DEPTH
property p_fifo_depth;
    @(posedge clk) disable iff (!rst_n)
    (wr_cnt - rd_cnt) <= FIFO_DEPTH;
endproperty
```

---

## 3. 状态机

### 3.1 无非法态（one-hot 编码）

```systemverilog
property p_one_hot_state;
    @(posedge clk) disable iff (!rst_n)
    $onehot(state);
endproperty
a_one_hot_state: assert property(p_one_hot_state)
    else $error("illegal state encoding");
```

### 3.2 状态转换合法

```systemverilog
property p_valid_transition;
    @(posedge clk) disable iff (!rst_n)
    $past(state) inside {IDLE, RUN, DONE} |->
        state inside {IDLE, RUN, DONE, ERROR};
endproperty
```

### 3.3 超时检测（stuck 检测）

```systemverilog
// 在某个状态停留超过 MAX_CYCLES 则报错
property p_state_timeout;
    @(posedge clk) disable iff (!rst_n)
    $rose(state == RUN) |-> ##[1:MAX_CYCLES] state != RUN;
endproperty
a_state_timeout: assert property(p_state_timeout)
    else $error("RUN state timeout (>%0d cycles)", MAX_CYCLES);
```

---

## 4. 流水线

### 4.1 数据流守恒（输入输出样点计数一致）

```systemverilog
property p_data_conservation;
    @(posedge clk) disable iff (!rst_n)
    (input_valid && input_ready) |-> ##PIPELINE_DEPTH
        (output_valid && output_ready);
endproperty
```

### 4.2 Pipeline 冲刷完整

```systemverilog
// 复位后 PIPELINE_DEPTH 周期内输出应归零
property p_pipeline_flush;
    @(posedge clk)
    !rst_n |=> ##[1:PIPELINE_DEPTH] output_data == 0;
endproperty
```

---

## 5. 计数器

### 5.1 计数范围合法

```systemverilog
property p_counter_range;
    @(posedge clk) disable iff (!rst_n)
    counter inside {[0:MAX_COUNT]};
endproperty
```

### 5.2 计数方向正确

```systemverilog
property p_counter_direction;
    @(posedge clk) disable iff (!rst_n)
    count_up && !count_down |=> counter == $past(counter) + 1;
endproperty
```

---

## 6. 复位行为

### 6.1 复位后输出归零

```systemverilog
property p_reset_output_zero;
    @(posedge clk)
    !rst_n |=> output_data == 0;
endproperty
a_reset_output_zero: assert property(p_reset_output_zero)
    else $error("output not zero after reset");
```

### 6.2 复位后状态机回到 IDLE

```systemverilog
property p_reset_state_idle;
    @(posedge clk)
    !rst_n |=> state == IDLE;
endproperty
```

---

## 7. 时序约束

### 7.1 跨时钟域同步器级数

```systemverilog
// 确保慢速→快速 CDC 至少 2 级同步器
property p_cdc_synchronizer;
    @(posedge fast_clk) disable iff (!rst_n)
    $stable(slow_data, 2);  // 2 级同步 = 2 拍稳定
endproperty
```

### 7.2 寄存器输出（不组合逻辑驱动）

```systemverilog
property p_registered_output;
    @(posedge clk)
    /* 通过 formal 验证 output 是否由寄存器直接驱动 */;
endproperty
```

---

## 8. 断言使用规范

| 规范 | 说明 |
|:-----|:------|
| ✅ 每个断言有 `property` + `assert` + `else $error(...)` | 完整三段式 |
| ✅ `disable iff (!rst_n)` | 所有断言必须处理复位 |
| ✅ 错误消息包含具体原因 | `$error("write when FIFO full")` 而不是空 |
| ❌ 不用 `$fatal`（仿真直接退出） | 用 `$error` + 继续运行 |
| ✅ cover property 记录关键事件 | `cover: handshake, state_entry, fifo_full` |
