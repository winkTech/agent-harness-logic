`timescale 1ns / 1ps
// template: ram_2port
// version: 1.1.0
// domain: comm
// description: 双端口 RAM，支持独立读写端口和可配置位宽/深度
// requires: 无
//---------------------------------------------------------------------------------------
// 名称: ram_2port
// 功能: 真双端口 RAM (两端口各自独立时钟, 均可读可写), 位宽/地址深度可配
// 端口: A 口 i_clk_a/i_en_a/i_we_a/i_addr_a/i_data_a -> o_data_a
//       B 口 i_clk_b/i_en_b/i_we_b/i_addr_b/i_data_b -> o_data_b
// 主要逻辑: 共享存储阵列 r_ram_array, 写由 i_we_x 控制, 读数据经端口输出寄存器
// 时序: 使能拍地址, 下一拍出数据 (读延迟 1 拍)
//
// 存储初值: **本模块不带 initial 初始化块**。综合源里的 initial 会被综合器忽略而
//   被仿真执行, 是仿真-上板不一致的经典来源, 本仓库 RTL 一律禁止 (rtl-semantic-oracle
//   no-initial-in-rtl)。需要确定初值时用 $readmemh 走独立 ROM 模块, 或由上电后的
//   写入流程显式清零, 不要在此处塞 initial。
//
// 红线 3 豁免声明 (docs/rules/01-hdl.md §Vivado 综合结论的证据要求):
//   本模块为 BRAM 推断模板, 输出寄存器 o_data_a/o_data_b **有意不带复位** ——
//   给 BRAM 输出寄存器加复位会阻断 Xilinx block RAM 硬件宏推断, 综合器会退化为
//   分布式 LUTRAM, 面积与 Fmax 双输。此为规范列明的唯一豁免项之一。
//   豁免生效条件: 使用者须用 report_utilization 确认本模块确实推断为 RAMB18/RAMB36,
//   若推断失败则豁免不成立, 必须回到通用寄存器写法。
//
// 使用禁区: 两端口同一拍写同一地址, 结果未定义 (硬件 BRAM 无仲裁), 由调用方避免。
//---------------------------------------------------------------------------------------


module ram_2port
#(
    parameter DWIDTH=32,
    parameter AWIDTH=9
)
(
    //Port A
    input                   i_clk_a     ,
    input                   i_en_a      ,
    input                   i_we_a      ,
    input [AWIDTH-1:0]      i_addr_a    ,
    input [DWIDTH-1:0]      i_data_a    ,
    output reg [DWIDTH-1:0] o_data_a    ,

    //Port B
    input                   i_clk_b     ,
    input                   i_en_b      ,
    input                   i_we_b      ,
    input [AWIDTH-1:0]      i_addr_b    ,
    input [DWIDTH-1:0]      i_data_b    ,
    output reg [DWIDTH-1:0] o_data_b
);
//---------------------------------------------------------------------------------------
//
//						Signal	Define
//
//---------------------------------------------------------------------------------------
reg [DWIDTH-1:0] r_ram_array [(1<<AWIDTH)-1:0]  ;
//---------------------------------------------------------------------------------------
//
//						PortA Write and Read
//
//---------------------------------------------------------------------------------------
always @(posedge i_clk_a) begin
    if (i_en_a)
    begin
        if (i_we_a)
            r_ram_array[i_addr_a] <= i_data_a;
        o_data_a <= r_ram_array[i_addr_a];
    end
end
//---------------------------------------------------------------------------------------
//
//						PortB Write and Read
//
//---------------------------------------------------------------------------------------
always @(posedge i_clk_b) begin
    if (i_en_b)
    begin
        if (i_we_b)
            r_ram_array[i_addr_b] <= i_data_b;
        o_data_b <= r_ram_array[i_addr_b];
    end
end
//---------------------------------------------------------------------------------------
//
//						Finish		Moudle
//
//---------------------------------------------------------------------------------------
endmodule
