---
title: "FPGA 算法实现"
domain: fpga
tags: [algorithm, implementation, digital-signal-processing]
created: 2026-06-01
updated: 2026-06-01
difficulty: advanced
source: "Verilog HDL算法与电路设计 通信和计算机网络典型案例.pdf"
---

# FPGA 算法实现

## 概述

本文档介绍常见算法在 FPGA 上的实现方法，包括以太网、LRU、帧同步、CAM/TCAM、哈希、深度包检测、漏桶、数据交换和加密算法。

---

## 一、以太网 MAC 控制器

### 接收 MAC 架构

```
MII 接口 → CRC 校验 → 地址过滤 → FIFO → 处理器接口
```

### 关键模块

| 模块 | 功能 |
|------|------|
| **MII 接口** | 物理层接口 |
| **CRC-32 校验** | 帧校验 |
| **地址过滤** | MAC 地址匹配 |
| **FIFO** | 数据缓冲 |

### CRC-32 实现

```verilog
// CRC-32 校验
module crc32 (
    input  wire        clk,
    input  wire        rst_n,
    input  wire        data_in,
    input  wire        valid_in,
    output reg  [31:0] crc_out
);

reg [31:0] crc_reg;

always @(posedge clk or negedge rst_n) begin
    if (!rst_n)
        crc_reg <= 32'hFFFFFFFF;
    else if (valid_in) begin
        crc_reg[0] <= data_in ^ crc_reg[28];
        crc_reg[1] <= data_in ^ crc_reg[28] ^ crc_reg[29];
        crc_reg[2] <= data_in ^ crc_reg[28] ^ crc_reg[29] ^ crc_reg[30];
        crc_reg[3] <= data_in ^ crc_reg[29] ^ crc_reg[30] ^ crc_reg[31];
        crc_reg[4] <= data_in ^ crc_reg[28] ^ crc_reg[30] ^ crc_reg[31];
        // ... 继续计算
    end
end

assign crc_out = ~crc_reg;

endmodule
```

---

## 二、LRU 算法

### 应用场景

- Cache 管理
- 路由查找
- 资源分配

### 实现方法

```verilog
// LRU 算法模块
module lru_controller #(
    parameter NUM_WAYS = 4,
    parameter ADDR_WIDTH = 32
)(
    input  wire clk,
    input  wire rst_n,
    input  wire access_valid,
    input  wire [ADDR_WIDTH-1:0] access_addr,
    output reg  [1:0] victim_way,
    output reg  victim_valid
);

// 链表结构
reg [1:0] lru_link [0:NUM_WAYS-1];

// 访问更新逻辑
// 替换决策逻辑

endmodule
```

---

## 三、帧同步电路

### PDH E1 帧同步

```
接收信号 → 检测帧同步码 → 状态机 → 同步锁定
```

### SDH 帧同步

```
接收信号 → 检测 A1/A2 字节 → 状态机 → 同步锁定
```

### 状态机实现

```verilog
// 帧同步状态机
module frame_sync (
    input  wire clk,
    input  wire rst_n,
    input  wire [7:0] data_in,
    input  wire valid_in,
    output reg  sync_locked
);

localparam [2:0]
    SEARCH = 3'b000,
    CHECK  = 3'b001,
    LOCK   = 3'b010,
    HALT   = 3'b011;

reg [2:0] state, next_state;
reg [7:0] frame_cnt;

// 状态转移逻辑
// 帧同步码检测

endmodule
```

---

## 四、CAM 和 TCAM

### CAM（Content Addressable Memory）

```
输入数据 → 并行比较 → 匹配输出
```

### TCAM（Ternary CAM）

```
输入数据 → 并行比较 → 掩码控制 → 匹配输出
```

### 应用场景

| 类型 | 应用 |
|------|------|
| **CAM** | 以太网地址表、VLAN 表 |
| **TCAM** | IP 路由表、ACL 规则 |

### 实现代码

```verilog
// CAM 模块
module cam #(
    parameter DEPTH = 256,
    parameter WIDTH = 48
)(
    input  wire clk,
    input  wire rst_n,
    input  wire [WIDTH-1:0] search_data,
    input  wire search_valid,
    output reg  [7:0] match_addr,
    output reg  match_valid
);

reg [WIDTH-1:0] cam_mem [0:DEPTH-1];
reg [DEPTH-1:0] match_vec;

// 并行比较逻辑
integer i;
always @(*) begin
    for (i = 0; i < DEPTH; i = i + 1)
        match_vec[i] = (cam_mem[i] == search_data);
end

// 优先编码器
always @(posedge clk) begin
    match_valid <= search_valid;
    match_valid <= 1'b0;
    for (i = 0; i < DEPTH; i = i + 1) begin
        if (match_vec[i]) begin
            match_addr <= i[7:0];
            match_valid <= 1'b1;
        end
    end
end

endmodule
```

---

## 五、哈希查找技术

### 哈希函数

```
地址 = hash(key) % 表大小
```

### 冲突解决

| 方法 | 说明 |
|------|------|
| **链表法** | 冲突元素链式存储 |
| **开放寻址法** | 寻找下一个空位 |
| **再哈希法** | 使用另一个哈希函数 |

### 多桶哈希

```verilog
// 双桶哈希查找
module dual_bucket_hash (
    input  wire clk,
    input  wire rst_n,
    input  wire [31:0] key,
    input  wire lookup_valid,
    output reg  [31:0] data_out,
    output reg  hit_valid
);

// 哈希函数计算
wire [7:0] hash1 = key[7:0] ^ key[15:8];
wire [7:0] hash2 = key[23:16] ^ key[31:24];

// 双桶存储
reg [31:0] bucket1 [0:255];
reg [31:0] bucket2 [0:255];

// 查找逻辑

endmodule
```

---

## 六、深度包检测 (DPI)

### 基于 DFA 的匹配引擎

```
输入数据 → 状态转移 → 匹配输出
```

### 关键模块

| 模块 | 功能 |
|------|------|
| **状态机** | DFA 状态转移 |
| **查找表** | 状态转移表 |
| **输出逻辑** | 匹配结果 |

### 实现代码

```verilog
// DPI 匹配引擎
module dpi_engine #(
    parameter NUM_STATES = 256,
    parameter NUM_CHARS = 256
)(
    input  wire clk,
    input  wire rst_n,
    input  wire [7:0] data_in,
    input  wire valid_in,
    output reg  match_valid,
    output reg  [7:0] match_id
);

reg [7:0] current_state;
reg [7:0] next_state;

// 状态转移表
reg [7:0] transition_table [0:NUM_STATES-1][0:NUM_CHARS-1];

// 状态转移逻辑
always @(*) begin
    next_state = transition_table[current_state][data_in];
end

// 状态更新
always @(posedge clk or negedge rst_n) begin
    if (!rst_n)
        current_state <= 8'h00;
    else if (valid_in)
        current_state <= next_state;
end

// 匹配检测
// 输出逻辑

endmodule
```

---

## 七、漏桶算法

### 应用场景

- 流量整形
- 速率限制
- QoS 控制

### 实现代码

```verilog
// 漏桶算法
module leaky_bucket #(
    parameter BUCKET_SIZE = 256,
    parameter LEAK_RATE = 1
)(
    input  wire clk,
    input  wire rst_n,
    input  wire packet_valid,
    input  wire [15:0] packet_size,
    output reg  drop_valid
);

reg [15:0] bucket_level;

// 漏桶逻辑
always @(posedge clk or negedge rst_n) begin
    if (!rst_n)
        bucket_level <= 16'd0;
    else begin
        if (packet_valid && (bucket_level + packet_size <= BUCKET_SIZE))
            bucket_level <= bucket_level + packet_size;
        else if (!packet_valid && (bucket_level >= LEAK_RATE))
            bucket_level <= bucket_level - LEAK_RATE;
    end
end

// 丢弃判断
always @(posedge clk) begin
    drop_valid <= packet_valid && (bucket_level + packet_size > BUCKET_SIZE);
end

endmodule
```

---

## 八、数据交换单元

### Crossbar 交换

```
输入端口 → 交叉矩阵 → 输出端口
```

### 共享缓存交换

```
输入端口 → 共享缓存 → 调度器 → 输出端口
```

### 实现代码

```verilog
// 8x8 Crossbar 交换
module crossbar_8x8 (
    input  wire clk,
    input  wire rst_n,
    input  wire [7:0] data_in [0:7],
    input  wire [7:0] valid_in,
    input  wire [2:0] sel [0:7],
    output reg  [7:0] data_out [0:7],
    output reg  [7:0] valid_out
);

// 交叉矩阵
// 仲裁逻辑
// 输出选择

endmodule
```

---

## 九、SM4 加密算法

### 算法结构

```
明文 → 轮密钥加 → S盒替换 → 线性变换 → 密文
```

### 关键模块

| 模块 | 功能 |
|------|------|
| **S盒** | 非线性替换 |
| **线性变换** | 扩散 |
| **密钥扩展** | 生成轮密钥 |

### 实现代码

```verilog
// SM4 加密模块
module sm4_encrypt (
    input  wire clk,
    input  wire rst_n,
    input  wire [127:0] plain_text,
    input  wire [127:0] master_key,
    input  wire encrypt_valid,
    output reg  [127:0] cipher_text,
    output reg  encrypt_done
);

// 轮密钥扩展
reg [31:0] round_keys [0:31];

// S盒替换
reg [7:0] sbox [0:255];

// 线性变换
// 轮函数

endmodule
```

---

## 十、最佳实践

### 设计原则
- [ ] 选择合适的算法实现方式
- [ ] 优化资源和性能平衡
- [ ] 使用流水线提高吞吐量

### 验证方法
- [ ] MATLAB 仿真对比
- [ ] 测试向量验证
- [ ] 性能指标测试

---

## 参考资源

- [Verilog HDL算法与电路设计 通信和计算机网络典型案例.pdf](../../../source/datasheets/verilog-sv/)
- [IEEE 802.3 标准](https://standards.ieee.org/)
- [FPGA 算法实现指南](https://www.xilinx.com/support/documentation/)
