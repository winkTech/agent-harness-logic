---
name: hdl-coding
description: HDL编码规范和最佳实践，适用于Verilog/SystemVerilog FPGA设计
version: 3.0.0
---

# HDL 编码 Skill 规范

> 版本: v3.0
> 适用范围: Verilog / SystemVerilog FPGA设计
> 核心原则: 时序安全 > 命名规范 > 代码结构 > 设计规范 > 代码风格

---

## 一、适用边界

### 必须使用本skill的场景

| 场景 | 说明 |
|------|------|
| RTL代码编写 | 新建/修改/重构Verilog或SystemVerilog模块 |
| Testbench编写 | 新建tb_*.v文件，编写仿真激励 |
| FPGA设计 | 状态机、流水线、存储器、接口、时钟域交叉 |

### 可跳过的场景

- 非HDL代码（Python、MATLAB、文档、配置文件）
- 非综合代码（仿真脚本.do、约束文件.xdc/.sdc、IP核配置）
- 简单修改（单行注释、格式调整、文档更新）

---

## 二、时序安全规则（最高优先级）

### 2.1 同步复位

```verilog
// 推荐：高电平同步复位
always @(posedge i_clk_sys) begin
    if (i_rst_sys) begin
        r_data <= 'd0;
    end else begin
        r_data <= i_data;
    end
end
```

**禁止**：全局异步复位（会导致亚稳态、recovery/removal violation、STA困难）

### 2.2 输入信号寄存

所有输入信号必须寄存，使用 `ri_` 前缀：
```verilog
always @(posedge i_clk_sys) begin
    if (i_rst_sys) begin
        ri_data      <= 'd0;
        ri_data_valid <= 1'b0;
    end else begin
        ri_data      <= i_data;
        ri_data_valid <= i_data_valid;
    end
end
```

### 2.3 输出信号处理

组合逻辑输出禁止，必须通过寄存器输出：
```verilog
reg [7:0] ro_result;
reg       ro_valid;
assign o_result = ro_result;
assign o_valid  = ro_valid;
```

### 2.4 跨时钟域处理

- 所有异步输入需要双寄存器同步（两级FF级联）
- 跨时钟域信号命名使用 `_cdc` 后缀
- 异步复位信号需要"异步复位、同步释放"处理

```verilog
reg r_data_sync1;
reg r_data_sync2;
always @(posedge i_clk_sys) begin
    r_data_sync1 <= i_async_data;
    r_data_sync2 <= r_data_sync1;
end
```

### 2.5 数据-使能对

强制配对检测，格式为 `i_xx_data` / `i_xx_dvalid`

### 2.6 禁止使用锁存器

- case语句必须添加default分支
- if…else语句必须添加else分支
- assign语句条件必须完整

---

## 三、命名规范

### 3.1 信号前缀规则（RTL专用）

| 类别 | 前缀 | 示例 |
|------|------|------|
| 输入信号 | `i_` | `i_clk`, `i_rst`, `i_data` |
| 输出信号 | `o_` | `o_data`, `o_valid` |
| 寄存器 | `r_` | `r_counter`, `r_state` |
| 连线 | `w_` | `w_enable`, `w_result` |
| 寄存输入 | `ri_` | `ri_data_valid` |
| 寄存输出 | `ro_` | `ro_result` |
| 参数/状态 | `P_` | `P_ST_IDLE`, `P_WIDTH` |

### 3.2 特殊信号命名

| 类别 | 规范 | 示例 |
|------|------|------|
| 数组 | `_array` 结尾 | `w_data_array` |
| 跨时钟域 | `_cdc` 后缀 | `data_cdc` |
| 时钟 | `i_clk_xx` | `i_clk_sys`, `i_clk_adc` |
| 复位 | `i_rst_xx` | `i_rst_sys`, `i_rst_adc` |

### 3.3 例外规则

AXI等标准接口信号不受前缀规则约束，保持协议原生命名。

### 3.4 Testbench命名（放宽）

TB内部信号可以不使用i_/o_前缀，但需注释说明。

---

## 四、代码结构规范

### 4.1 RTL代码结构顺序

```verilog
1. 模块声明和I/O定义
2. 参数/状态定义（P_）
3. 输入信号寄存（ri_）
4. 输出信号寄存（ro_）和assign
5. 例化模块
6. 状态机实现
7. 组合逻辑
8. 时序逻辑
9. 数组赋值（放最后）
```

### 4.2 模块划分原则

- 功能模块划分清晰，各模块功能明确
- 将功能关联较强的代码放在同一模块
- 顶层文件和底层文件分别放置于不同目录
- 大模块按功能子模块划分，禁止超大规模模块
- 模块内部高内聚、对外低耦合

### 4.3 文件命名规范

- 一个文件内只包含一个module
- 源文件名和module名保持一致
- 文件命名使用小写字母、下划线和数字，以字母开头
- RTL级代码文件以".v"作为后缀
- 仿真代码文件以"sim.v"作为后缀
- 源代码文件保存格式使用UTF-8

### 4.4 代码格式规范

- 每行代码长度限制在78个字符以内
- 使用空格，不使用Tab键
- 在具体的设计逻辑前后留有一行的间隔
- 每行只能放置一条语句
- 输入输出信号每一行只定义一个
- 代码中避免出现Magic Number

---

## 五、注释规范

### 5.1 模块头部注释模板

```verilog
//-----------------------------------------------------------------
//                         模块名称
//-----------------------------------------------------------------
// 功能描述: 实现XXX功能
// 输入:
//   i_clk_sys  - 系统时钟
//   i_rst_sys  - 系统复位（高有效）
//   i_data     - 输入数据
//   i_valid    - 输入有效信号
// 输出:
//   o_result   - 处理结果
//   o_valid    - 输出有效信号
//-----------------------------------------------------------------
// 主要逻辑:
//   1. 输入数据打一拍寄存
//   2. 状态机控制数据处理流程
//   3. 输出结果通过寄存器驱动
//-----------------------------------------------------------------
```

### 5.2 注释要求

- 注释需要对齐
- 加减乘除等算法和逻辑处理需要注释其相关公式
- 尽量每个always、generate、task、function都有完整简练的注释
- 注释采用英文撰写

### 5.3 Testbench注释（放宽）

TB可以使用中文注释，测试用例必须有清晰的描述。

---

## 六、代码对齐规范

### 6.1 信号声明对齐

- 位宽对齐：[X:0]统一缩进至相同列
- 信号对齐：变量名起始位置对齐
- 分号对齐：所有分号垂直对齐
- 注释对齐：所有//垂直对齐，注释文本对齐

### 6.2 连续赋值对齐

- assign关键字左对齐
- 左值对齐：输出信号名起始位置对齐
- 等号对齐：所有=垂直对齐
- 右值对齐：表达式起始位置对齐

### 6.3 特殊场景处理

信号名超长（超过20字符）时：
- 位宽对齐可适当放宽
- 注释可单独成行
- 必须保持等号、分号、注释符号垂直对齐
- 推荐：超长信号名控制在32字符内

---

## 七、状态机设计规范

### 7.1 设计要求

- 必须包含default分支
- 当前计算逻辑到下个时钟周期才可使用
- 通常采用三段式进行设计
- 使用localparam定义状态
- 状态转换逻辑清晰

### 7.2 三段式状态机模板

```verilog
// 状态定义
localparam P_ST_IDLE  = 2'b00;
localparam P_ST_READ  = 2'b01;
localparam P_ST_WRITE = 2'b10;
localparam P_ST_DONE  = 2'b11;

// 状态寄存器
reg [1:0] r_cur_state;
reg [1:0] r_nxt_state;

// 第一段：状态寄存器（时序逻辑）
always @(posedge i_clk_sys) begin
    if (i_rst_sys) begin
        r_cur_state <= P_ST_IDLE;
    end else begin
        r_cur_state <= r_nxt_state;
    end
end

// 第二段：状态转移逻辑（组合逻辑）
always @(*) begin
    case (r_cur_state)
        P_ST_IDLE: begin
            if (ri_valid) begin
                r_nxt_state = P_ST_READ;
            end else begin
                r_nxt_state = P_ST_IDLE;
            end
        end
        P_ST_READ: begin
            r_nxt_state = P_ST_WRITE;
        end
        P_ST_WRITE: begin
            r_nxt_state = P_ST_DONE;
        end
        P_ST_DONE: begin
            r_nxt_state = P_ST_IDLE;
        end
        default: begin
            r_nxt_state = P_ST_IDLE;
        end
    endcase
end

// 第三段：输出逻辑（时序逻辑）
always @(posedge i_clk_sys) begin
    if (i_rst_sys) begin
        ro_result <= 'd0;
        ro_valid  <= 1'b0;
    end else begin
        case (r_nxt_state)
            P_ST_READ: begin
                ro_result <= ri_data;
            end
            P_ST_WRITE: begin
                ro_valid <= 1'b1;
            end
            default: begin
                ro_valid <= 1'b0;
            end
        endcase
    end
end
```

### 7.3 状态编码选择建议

| 状态个数 | 推荐编码 | 说明 |
|---------|---------|------|
| ≤ 5 | 二进制码 | 使用最少触发器 |
| 5~50 | 独热码 | 组合逻辑少，易时序收敛 |
| > 50 | 格雷码 | 低功耗设计 |

---

## 八、流水线设计规范

### 8.1 设计要求

- 寄存器隔离每级计算
- valid信号严格同步传递
- 复位清除所有流水状态
- 计算位宽自动扩展

### 8.2 流水线模板

```verilog
reg [7:0] r_pipe_data [0:2];
reg       r_pipe_valid [0:2];

// 流水线第一级
always @(posedge i_clk_sys) begin
    if (i_rst_sys) begin
        r_pipe_data[0]  <= 'd0;
        r_pipe_valid[0] <= 1'b0;
    end else begin
        r_pipe_data[0]  <= ri_data;
        r_pipe_valid[0] <= ri_valid;
    end
end

// 流水线第二级
always @(posedge i_clk_sys) begin
    if (i_rst_sys) begin
        r_pipe_data[1]  <= 'd0;
        r_pipe_valid[1] <= 1'b0;
    end else begin
        r_pipe_data[1]  <= r_pipe_data[0] + 1;
        r_pipe_valid[1] <= r_pipe_valid[0];
    end
end

// 流水线第三级
always @(posedge i_clk_sys) begin
    if (i_rst_sys) begin
        r_pipe_data[2]  <= 'd0;
        r_pipe_valid[2] <= 1'b0;
    end else begin
        r_pipe_data[2]  <= r_pipe_data[1] * 2;
        r_pipe_valid[2] <= r_pipe_valid[1];
    end
end

assign o_data  = r_pipe_data[2];
assign o_valid = r_pipe_valid[2];
```

---

## 九、参数化设计规范

### 9.1 参数定义规范

- 参数前缀：使用 `P_` 前缀（大写）
- 参数类型：使用 `parameter` 或 `localparam`
- 参数命名：全大写 + 下划线

### 9.2 参数化模板

```verilog
module module_name #(
    parameter P_DATA_WIDTH = 8,
    parameter P_ADDR_WIDTH = 4
)(
    // 端口定义
);

localparam P_DEPTH = 1 << P_ADDR_WIDTH;
localparam P_MAX_VALUE = {P_DATA_WIDTH{1'b1}};
```

---

## 十、存储器建模规范

### 10.1 存储器模板

```verilog
reg [P_DATA_WIDTH-1:0] r_mem [0:P_DEPTH-1];

// 读操作
assign o_rd_data = r_mem[r_rd_ptr];

// 写操作
always @(posedge i_clk_sys) begin
    if (ri_wr_en && !ro_full) begin
        r_mem[r_wr_ptr] <= ri_wr_data;
    end
end
```

### 10.2 存储器初始化

- 仿真初始化：使用 `initial` 块初始化
- 综合初始化：使用复位信号初始化（如需要）
- 复位时采用 `{default:'d0}` 语法初始化数组

---

## 十一、always语句使用规范

### 11.1 基本要求

- 敏感列表中需要列出所有输入信号或使用"*"
- 时序逻辑中，时钟信号作为"posedge"描述的第一个信号
- 被赋值的变量一定要是"reg"类型
- assign语句和实例化语句中被赋值的信号，一定要是"wire"类型

### 11.2 敏感列表完整性

- always@(*)后面不能直接跟标点符号
- always@(*)后面不能跟$finish语句
- always@(*)后面不跟fork…join语句

---

## 十二、信号赋值规范

### 12.1 阻塞赋值与非阻塞赋值

- 非阻塞赋值不允许出现在assign语句中
- 时序逻辑中，不能使用阻塞赋值
- 组合逻辑中，不能使用非阻塞赋值
- 在同一个always语句中，只允许使用非阻塞赋值

### 12.2 assign语句限制

- assign语句和always语句不能对同一个变量进行赋值
- assign语句不能出现在always语句中

### 12.3 信号使用规范

- 不能将一个变量同时赋值给多个变量
- 除了顶层文件外，每个模块都需要定义输出端口
- 在一个模块中，一个变量只能被赋值一次
- 未使用的输入端口可以直接留空
- 未使用的输出端口不能留空

---

## 十三、位宽与符号处理

### 13.1 位宽匹配

- 当赋值等式左右位宽不匹配时，需要做出合理的处理
- 直接改变符号会导致时序问题，建议先通过位扩展改变符号
- 有符号数和无符号数不能直接进行运算，需要进行符号转换

### 13.2 位宽优化

- 对于不需要位扩展的运算，在定义变量时，可以直接截取需要的位宽
- 可以通过"位选择"和"拼接"等方式实现位宽转换
- 在定义变量时，要对每个变量的位宽进行准确描述

### 13.3 整数处理

- 不能直接使用整数（integer）进行赋值
- 在使用整数时，需要定义整数的位宽
- 使用整数时需要进行循环赋值

---

## 十四、复位规范

### 14.1 复位策略选择

| 场景 | 推荐策略 | 说明 |
|------|----------|------|
| 数据路径 | 无复位 | 面积最优，时序最优 |
| 控制逻辑 | 同步复位 | 高电平有效 |
| 必须复位 | 异步复位同步释放 | 仅用于上电初始化 |

### 14.2 异步复位同步释放模板

```verilog
reg r_rst_sync;

always @(posedge i_clk_sys or posedge i_rst_async) begin
    if (i_rst_async) begin
        r_rst_sync <= 1'b1;
    end else begin
        r_rst_sync <= 1'b0;
    end
end

always @(posedge i_clk_sys) begin
    if (r_rst_sync) begin
        r_data <= 'd0;
    end else begin
        r_data <= i_data;
    end
end
```

---

## 十五、时钟规范

### 15.1 时钟基本要求

- 时钟信号建议加上后缀区分（i_clk_xx）
- 在顶层文件中，要对时钟信号进行处理
- 外部输入的时钟信号只能在顶层文件中使用

### 15.2 时钟处理

- 时钟信号通过PLL或MMCM产生
- 使用PLL或MMCM产生的时钟信号，需要对locked信号进行处理
- 不要使用组合逻辑产生的信号作为时钟信号或复位信号
- 对于需要进行时钟分频、倍频或相位调整的设计，需要通过PLL或MMCM来实现

---

## 十六、特殊电路设计

### 16.1 除法器设计

- FPGA中没有专用的除法器电路，需要通过移位寄存器和加减法实现
- 若除数为常数，需要将除法操作转换为常数乘法操作
- 若除数为常数且为2的幂次方，则可以直接使用移位操作

### 16.2 乘法器设计

- 若设计中存在乘法或者除法运算，则需使用流水线结构
- 在使用乘法或除法运算符时，尽量让乘数或除数是常数
- 尽量让乘数或除数是2的幂次方

### 16.3 高扇出信号

- 信号的扇出不能太大，需减小高扇出信号
- 使用寄存器对信号进行打一拍处理
- 在模块例化时，使用寄存器打一拍的信号作为新的输入信号

### 16.4 三态门

- 除了顶层文件外，不允许使用三态门
- 可以将三态门编写成独立的子模块
- 顶层文件中不建议使用inout端口

---

## 十七、Testbench规范

### 17.1 文件规范

- 文件命名：`tb_<module_name>.v`
- 模块命名：`tb_<module_name>`
- 文件位置：`02_sim/` 目录

### 17.2 Testbench结构模板

```verilog
//-----------------------------------------------------------------
//                         模块Testbench
//-----------------------------------------------------------------
// 功能描述: 验证XXX模块的功能正确性
// 测试场景:
//   1. 复位测试 - 验证复位期间输出为初始值
//   2. 功能测试 - 验证基本功能
//   3. 边界测试 - 验证边界条件
//   4. 异常测试 - 验证异常处理
//-----------------------------------------------------------------

`timescale 1ns / 1ps

module tb_<module_name>;

    //-----------------------------------------------------------------
    // 参数定义
    //-----------------------------------------------------------------
    parameter P_DATA_WIDTH = 8;
    parameter P_CLK_PERIOD = 10;

    //-----------------------------------------------------------------
    // 信号声明
    //-----------------------------------------------------------------
    reg                    i_clk_sys;
    reg                    i_rst_sys;
    // ... 其他信号

    //-----------------------------------------------------------------
    // 时钟生成
    //-----------------------------------------------------------------
    initial i_clk_sys = 0;
    always #(P_CLK_PERIOD/2) i_clk_sys = ~i_clk_sys;

    //-----------------------------------------------------------------
    // 实例化待测模块
    //-----------------------------------------------------------------
    <module_name> #(
        .P_DATA_WIDTH (P_DATA_WIDTH)
    ) u_<module_name> (
        .i_clk_sys  (i_clk_sys),
        .i_rst_sys  (i_rst_sys),
        // ...
    );

    //-----------------------------------------------------------------
    // 测试激励
    //-----------------------------------------------------------------
    initial begin
        // 波形输出
        $dumpfile("tb_<module_name>.vcd");
        $dumpvars(0, tb_<module_name>);

        // 初始化信号
        i_rst_sys = 1;
        // ...

        // 测试用例1: 复位测试
        $display("=== Test 1: Reset Test ===");
        // ...

        // 测试用例2: 功能测试
        $display("=== Test 2: Function Test ===");
        // ...

        // 测试完成
        $display("=== All Tests Passed ===");
        $finish(0);
    end

    //-----------------------------------------------------------------
    // 超时保护
    //-----------------------------------------------------------------
    initial begin
        #(P_CLK_PERIOD * 1000);
        $display("FAIL: Simulation timeout");
        $finish(1);
    end

endmodule
```

### 17.3 TB专属规范

- 测试用例命名：`=== Test N: 描述 ===`
- 结果输出：使用 `$display` 输出测试结果
- 波形输出：使用 `$dumpfile` / `$dumpvars`
- 超时保护：必须设置仿真超时时间
- 错误处理：使用 `$finish(1)` 表示失败，`$finish(0)` 表示成功

### 17.4 TB可以放宽的规范

- 命名规范：内部信号可以不使用i_/o_前缀
- 复位规范：可以使用异步复位进行初始化（仅限initial块）
- 代码结构：可以简化模块头部注释
- 对齐规范：可以适当放宽对齐要求
- 注释规范：可以使用中文注释

---

## 十八、设计检查清单

### 18.1 时序检查

- [ ] 是否使用同步复位（高电平有效）？
- [ ] 所有输入信号是否已寄存（ri_前缀）？
- [ ] 输出是否通过寄存器驱动（ro_前缀）？
- [ ] 异步输入是否双寄存器同步？
- [ ] 跨时钟域是否插入同步器链？

### 18.2 命名检查

- [ ] 信号前缀是否符合规范（i_/o_/r_/w_/ri_/ro_）？
- [ ] 时钟和复位是否使用 i_clk_xx / i_rst_xx 格式？
- [ ] 数组是否以 _array 结尾？
- [ ] 跨时钟域信号是否以 _cdc 结尾？

### 18.3 代码结构检查

- [ ] 代码结构顺序是否正确？
- [ ] 模块头部注释是否完整？
- [ ] always块是否有注释说明？

### 18.4 状态机检查

- [ ] 是否采用三段式状态机？
- [ ] 是否使用localparam定义状态？
- [ ] 是否包含default分支？

### 18.5 复位检查

- [ ] 是否避免使用全局异步复位？
- [ ] 数据路径是否无复位？
- [ ] 控制逻辑是否使用同步复位？

### 18.6 代码质量检查

- [ ] 是否存在latch？
- [ ] 条件描述是否完整？
- [ ] 位宽是否匹配？
- [ ] 阻塞/非阻塞赋值是否正确？

### 18.7 Testbench检查

- [ ] 文件命名是否为tb_*？
- [ ] 是否包含时钟生成？
- [ ] 是否包含超时保护？
- [ ] 测试用例是否覆盖关键场景？
- [ ] 波形输出是否配置？

---

## 十九、常见错误与解决方案

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| 时序违例 | 关键路径过长 | 增加流水线级数，寄存器隔离 |
| 亚稳态 | 跨时钟域信号不稳定 | 双寄存器同步，使用 _cdc 命名 |
| 复位问题 | 复位恢复/移除时序违例 | 异步复位同步释放，或使用同步复位 |
| 面积过大 | 不必要的复位逻辑 | 数据路径无复位，仅控制逻辑复位 |
| latch问题 | 条件描述不完整 | 添加else分支或default分支 |
| 位宽问题 | 位宽不匹配导致数据丢失 | 位扩展或截取，确保位宽一致 |

---

## 二十、工具使用

### 20.1 语法检查

- **Verilog**: `vlog -lint <file>.v`
- **SystemVerilog**: `vlog -sv -lint <file>.sv`

### 20.2 仿真验证

- **ModelSim**: `vsim -c -do "run -all; quit -f" tb_<module>`
- **Vivado**: `xsim tb_<module> -runall`

### 20.3 HDL 质量门禁

```bash
# ModelSim 流程
vlog -lint rtl/*.v tb/tb_*.v
vsim -c -do "run -all; quit -f" tb_<module>

# Vivado 流程
xvlog rtl/*.v tb/tb_*.v
xelab tb_<module> -debug typical
xsim tb_<module> -runall
```

---

## 二十一、RTL代码审查规范

> 专门针对Verilog/SystemVerilog RTL代码的审查规则，补充code-review插件的通用审查

### 11.1 时序安全检查（最高优先级）

#### 同步复位检查
- [ ] 是否使用高电平同步复位？
- [ ] 是否避免使用全局异步复位？
- [ ] 异步复位是否进行"异步复位、同步释放"处理？

#### 输入信号寄存检查
- [ ] 所有输入信号是否已寄存（ri_前缀）？
- [ ] 是否避免直接使用未经寄存的输入信号？

#### 输出信号处理检查
- [ ] 是否避免组合逻辑直接输出？
- [ ] 输出是否通过寄存器驱动（ro_前缀）？

#### 跨时钟域处理检查
- [ ] 异步输入是否双寄存器同步？
- [ ] 跨时钟域信号是否使用 `_cdc` 后缀？
- [ ] 异步复位是否进行同步处理？

### 11.2 命名规范检查

#### 信号前缀检查
- [ ] 输入信号是否使用 `i_` 前缀？
- [ ] 输出信号是否使用 `o_` 前缀？
- [ ] 内部寄存器是否使用 `r_` 前缀？
- [ ] 内部连线是否使用 `w_` 前缀？
- [ ] 寄存输入是否使用 `ri_` 前缀？
- [ ] 寄存输出是否使用 `ro_` 前缀？
- [ ] 参数/状态是否使用 `P_` 前缀？

#### 特殊信号命名检查
- [ ] 时钟信号是否使用 `i_clk_xx` 格式？
- [ ] 复位信号是否使用 `i_rst_xx` 格式？
- [ ] 跨时钟域信号是否以 `_cdc` 结尾？
- [ ] 数组是否以 `_array` 结尾？

### 11.3 状态机检查

#### 状态机结构检查
- [ ] 是否采用三段式状态机？
- [ ] 是否使用 `localparam` 定义状态？
- [ ] 是否包含 `default` 分支？

#### 状态编码检查
- [ ] 状态个数 ≤ 5 时是否使用二进制码？
- [ ] 状态个数 5~50 时是否使用独热码？
- [ ] 状态个数 > 50 时是否使用格雷码？

### 11.4 代码结构检查

#### 模块头部注释检查
- [ ] 是否包含模块名称？
- [ ] 是否包含功能描述？
- [ ] 是否包含输入输出端口说明？
- [ ] 是否包含主要逻辑说明？

#### 代码顺序检查
- [ ] 是否按正确顺序组织代码？
  1. 模块声明和I/O定义
  2. 参数/状态定义（P_）
  3. 输入信号寄存（ri_）
  4. 输出信号寄存（ro_）和assign
  5. 例化模块
  6. 状态机实现
  7. 组合逻辑
  8. 时序逻辑
  9. 数组赋值（放最后）

### 11.5 代码质量检查

#### 锁存器检查
- [ ] case语句是否添加default分支？
- [ ] if…else语句是否添加else分支？
- [ ] assign语句条件是否完整？

#### 位宽匹配检查
- [ ] 赋值等式左右位宽是否匹配？
- [ ] 有符号数和无符号数是否混合运算？
- [ ] 乘法器输出位宽是否正确？

#### 阻塞/非阻塞赋值检查
- [ ] 时序逻辑是否使用非阻塞赋值（<=）？
- [ ] 组合逻辑是否使用阻塞赋值（=）？
- [ ] 同一always语句中是否混用阻塞和非阻塞赋值？

### 11.6 Testbench检查

#### 文件规范检查
- [ ] 文件命名是否为 `tb_<module_name>.v`？
- [ ] 模块命名是否为 `tb_<module_name>`？
- [ ] 文件位置是否在 `02_sim/` 目录？

#### 测试结构检查
- [ ] 是否包含时钟生成？
- [ ] 是否包含超时保护？
- [ ] 测试用例是否覆盖关键场景？
- [ ] 波形输出是否配置？

---

## 二十二、RTL代码简化规范

> 专门针对Verilog/SystemVerilog RTL代码的简化规则，补充code-simplifier插件的通用简化

### 12.1 简化原则

#### 保持功能不变
- **核心原则**：简化只改变代码结构，不改变功能
- **验证方法**：简化前后Testbench结果必须一致

#### 提高可读性
- **目标**：让代码更容易理解和维护
- **方法**：减少复杂度、消除冗余、改善命名

#### 遵循规范
- **必须遵守**：时序安全规则、命名规范、代码结构
- **可以优化**：代码风格、冗余逻辑、复杂表达式

### 12.2 状态机简化

#### 合并冗余状态
```verilog
// 简化前：多个相似状态
localparam P_ST_IDLE = 3'b000;
localparam P_ST_WAIT1 = 3'b001;
localparam P_ST_WAIT2 = 3'b010;
localparam P_ST_WAIT3 = 3'b011;

// 简化后：使用计数器合并等待状态
localparam P_ST_IDLE = 2'b00;
localparam P_ST_WAIT = 2'b01;
localparam P_ST_PROC = 2'b10;
localparam P_ST_DONE = 2'b11;

reg [1:0] r_wait_cnt;
```

#### 优化状态编码
```verilog
// 简化前：二进制编码（状态多时组合逻辑复杂）
localparam P_ST_IDLE = 3'b000;
localparam P_ST_RUN  = 3'b001;
localparam P_ST_DONE = 3'b010;

// 简化后：独热码（状态多时组合逻辑简单）
localparam P_ST_IDLE = 4'b0001;
localparam P_ST_RUN  = 4'b0010;
localparam P_ST_DONE = 4'b0100;
```

### 12.3 流水线优化

#### 减少流水线级数
```verilog
// 简化前：过多流水线级数
// 第一级：输入寄存
// 第二级：预处理
// 第三级：计算1
// 第四级：计算2
// 第五级：输出寄存

// 简化后：合并相邻级
// 第一级：输入寄存 + 预处理
// 第二级：计算1 + 计算2
// 第三级：输出寄存
```

### 12.4 资源共享

#### 复用乘法器
```verilog
// 简化前：多个乘法器
wire [15:0] w_prod1 = r_a * r_b;
wire [15:0] w_prod2 = r_c * r_d;
wire [15:0] w_prod3 = r_e * r_f;

// 简化后：时分复用一个乘法器
reg [15:0] r_mult_result;
reg [1:0] r_sel;

always @(posedge i_clk_sys) begin
    case (r_sel)
        2'b00: r_mult_result <= r_a * r_b;
        2'b01: r_mult_result <= r_c * r_d;
        2'b10: r_mult_result <= r_e * r_f;
    endcase
end
```

### 12.5 逻辑优化

#### 简化条件表达式
```verilog
// 简化前：复杂的条件表达式
if (r_state == P_ST_IDLE && ri_valid && ri_ready && !ri_error && ri_data != 0) begin
    // ...
end

// 简化后：提取条件为信号
wire w_can_start = (r_state == P_ST_IDLE) && ri_valid && ri_ready && !ri_error && (ri_data != 0);

if (w_can_start) begin
    // ...
end
```

### 12.6 代码结构优化

#### 提取公共逻辑
```verilog
// 简化前：重复的逻辑
always @(posedge i_clk_sys) begin
    if (r_sel_a) begin
        r_result <= r_a * r_b + r_c;
    end else begin
        r_result <= r_d * r_e + r_f;
    end
end

// 简化后：提取公共计算
wire [15:0] w_mult = r_sel_a ? (r_a * r_b) : (r_d * r_e);
wire [7:0] w_add = r_sel_a ? r_c : r_f;

always @(posedge i_clk_sys) begin
    r_result <= w_mult + w_add;
end
```

### 12.7 简化检查清单

#### 简化前检查
- [ ] 理解当前代码功能
- [ ] 确认简化目标
- [ ] 备份当前代码
- [ ] 准备Testbench验证

#### 简化后检查
- [ ] 功能是否保持不变？
- [ ] Testbench是否通过？
- [ ] 时序是否满足要求？
- [ ] 资源使用是否优化？
- [ ] 代码可读性是否提高？

---

## 二十三、参考资料

详细规范请参考以下文件：

| 主题 | 文件 | 说明 |
|------|------|------|
| 时序约束 | `references/timing-constraints.md` | FPGA时序约束与分析详细规范 |
| FPGA优化 | `references/fpga-optimization.md` | FPGA设计优化指南 |
| FPGA开发 | `references/fpga-development.md` | Vivado开发、AXI接口、功耗优化 |
| 设计最佳实践 | `references/design-best-practices.md` | 基于团队的最佳实践 |
| 算术逻辑部件 | `references/alu-design.md` | 加法器、ALU等设计 |
| 算法硬件实现 | `references/algorithm-hardware.md` | CRC、哈希、CAM等算法 |
| 算法到Verilog | `references/alg-flow-verilog.md` | MATLAB/Python算法模型到Verilog RTL转换 |
| MATLAB编码规范 | `references/matlab-rule.md` | MATLAB代码组织、命名、编码约束 |
| 开发工具链 | `references/toolchain.md` | FPGA/MATLAB/Python工具链说明 |

### 遗留参考（已融合）

| 文件 | 说明 | 状态 |
|------|------|------|
| `references/RTL_DESIGN_RULE.md` | RTL编码规则（已融合到本Skill） | ✅ 已合并 |
| `/fpga` | FPGA开发指南（已融合到本Skill） | ✅ 已合并 |
| `/systemverilog` | SystemVerilog开发指南（已融合到本Skill） | ✅ 已合并 |

---

## 版本历史

- v3.1 (2026-05-31): 融合RTL_DESIGN_RULE.md，完善遗留参考索引
- v3.0 (2026-05-31): 架构重构，分离核心规则与详细参考，优化为渐进式披露
- v2.14 (2026-05-30): 增加全部完整设计案例（6个项目）
- v2.0 (2026-05-30): 完整版，覆盖所有资料要点
- v1.0 (2026-05-30): 初始版本
