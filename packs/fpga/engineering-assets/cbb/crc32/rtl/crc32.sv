`default_nettype none
//==============================================================================
// crc32 — CRC-32 帧校验和计算 (IEEE 802.3 反射语义, 字节流)
// 功能: 逐字节吸收帧数据, i_last 拍收尾后输出最终 FCS (已末尾取反)
// 端口: i_clk/i_rst(同步高有效); i_valid/i_data[8]/i_last -> o_valid/o_crc
// 主要逻辑: 输入寄存(ri_) -> 反射式 CRC 状态更新 -> 输出寄存(ro_)
// 延迟: i_last 拍后 2 拍 o_valid 单拍脉冲, o_crc 同拍有效并保持到下一帧
// 语义 (以 IEEE 检验值钉死, TB 硬锚 '123456789' -> 0xCBF43926):
//   init 0xFFFFFFFF; LSB-first 反射多项式 0xEDB88320; 末尾按位取反。
//   帧尾自动回 init, 支持背靠背帧 (i_last 后下一拍即可开新帧)。
// 背压: 无 tready (与 delay_line 同约定), 需要背压在上游例化 axis_skid_buffer
//
// 来源: 改写自 skills/hdl-coding/templates/internet/crc32.v (v1.0.0)
//   原件缺陷 (本模块逐条修复):
//     (1) 语义错配: 声称"以太网帧校验", 实现却是非反射 MSB-first
//         (poly 0x04C11DB7 左移) 且无末尾取反 —— 以太网 FCS 是反射式
//         LSB-first; 原件对 '123456789' 得 0x0376E6E7 ≠ 0xCBF43926,
//         按声称场景使用必然校验失败;
//     (2) 无帧界: 没有 i_last, 多帧计算只能靠复位整个模块;
//     (3) 无完成指示: 没有 o_valid, 下游无从知道何时采样 o_crc;
//     (4) 红线 1: i_data/i_valid 未经寄存直接进入组合计算。
//==============================================================================
module crc32 (
    input  wire logic        i_clk,
    input  wire logic        i_rst,       // 同步复位, 高有效

    input  wire logic        i_valid,
    input  wire logic [7:0]  i_data,
    input  wire logic        i_last,      // 帧末字节标记

    output logic             o_valid,     // 单拍: o_crc 为该帧最终 FCS
    output logic [31:0]      o_crc
);

    localparam logic [31:0] P_POLY_REFLECTED = 32'hEDB8_8320;
    localparam logic [31:0] P_INIT           = 32'hFFFF_FFFF;

    //==========================================================================
    // 输入寄存 (红线 1)
    //==========================================================================
    logic       ri_valid, ri_last;
    logic [7:0] ri_data;

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            ri_valid <= 1'b0;
            ri_last  <= 1'b0;
            ri_data  <= 8'h00;
        end else begin
            ri_valid <= i_valid;
            ri_last  <= i_valid && i_last;
            ri_data  <= i_data;
        end
    end

    //==========================================================================
    // CRC 状态更新: 反射式逐位展开 8 步 (纯组合, 单字节/拍)
    //==========================================================================
    logic [31:0] r_crc;
    logic [31:0] w_crc_next;

    function automatic logic [31:0] f_crc_byte(input logic [31:0] c_in,
                                               input logic [7:0]  d);
        logic [31:0] c;
        begin
            c = c_in ^ {24'h0, d};
            for (int k = 0; k < 8; k++)
                c = c[0] ? ((c >> 1) ^ P_POLY_REFLECTED) : (c >> 1);
            f_crc_byte = c;
        end
    endfunction

    assign w_crc_next = f_crc_byte(r_crc, ri_data);

    always_ff @(posedge i_clk) begin
        if (i_rst)          r_crc <= P_INIT;
        else if (ri_valid)  r_crc <= ri_last ? P_INIT : w_crc_next;  // 帧尾回 init
    end

    //==========================================================================
    // 输出寄存 (红线 2): 帧尾拍锁存最终值 (含末尾取反)
    //==========================================================================
    logic        ro_valid;
    logic [31:0] ro_crc;

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            ro_valid <= 1'b0;
            ro_crc   <= 32'h0;
        end else begin
            ro_valid <= ri_last;
            if (ri_last) ro_crc <= ~w_crc_next;
        end
    end

    assign o_valid = ro_valid;
    assign o_crc   = ro_crc;

endmodule
`default_nettype wire
