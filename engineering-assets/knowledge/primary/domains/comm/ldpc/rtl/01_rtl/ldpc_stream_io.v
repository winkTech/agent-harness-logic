//-----------------------------------------------------------------
//                  LDPC Decoder Stream I/O
//-----------------------------------------------------------------
// 功能描述: 译码器的 AXI4-Stream 收发侧, 与译码核解耦。
//   入口: 收 P_N 个通道 LLR, 逐个写进 llr_buffer, 满帧后给出 o_llr_loaded
//   出口: 译码完成后回读 llr_buffer 前 P_K 个字, 取符号位作硬判决逐位吐出
//
// 端口要点:
//   i_busy / i_decode_done  来自控制器 (启动脉冲 / 完成脉冲)
//   o_load_wr_*             加载期驱动 llr_buffer 写口
//   o_out_active / o_out_addr  输出期抢占 llr_buffer 读地址
//   i_llr_rd_data           llr_buffer 同步读数据 (取 MSB 作硬判决)
//
// 帧间握手 (踩过两次的地方, 改动前先读):
//   1. o_llr_loaded 是**启动脉冲语义**: 控制器一离开 IDLE (i_busy 拉高) 就落下。
//      若留到输出扫描结束才清, 控制器在 DONE->IDLE 后会看到它仍为 1, 立刻把
//      同一帧再译一遍; 那次多余译码的 decode_done 会在输出扫描中途重启扫描,
//      表现为"隔一帧错一帧"。
//   2. s_axis_llr_tready 必须同时排除 i_busy 与输出扫描, 否则新帧的 LLR 会在
//      旧帧还在回读 llr_buffer 时写进去。
//-----------------------------------------------------------------

module ldpc_stream_io #(
    parameter P_N               = 648,
    parameter P_K               = 324,
    parameter P_Q_DATA_W        = 10,
    parameter P_LLR_ADDR_W      = 10
)(
    input  wire                             i_clk_sys,
    input  wire                             i_rst_sys,

    // AXI4-Stream 从端: 通道 LLR
    input  wire signed [P_Q_DATA_W-1:0]     s_axis_llr_tdata,
    input  wire                             s_axis_llr_tvalid,
    output wire                             s_axis_llr_tready,

    // AXI4-Stream 主端: 硬判决
    output wire                             m_axis_data_tdata,
    output wire                             m_axis_data_tvalid,
    input  wire                             m_axis_data_tready,

    // 与译码核
    input  wire                             i_busy,
    input  wire                             i_decode_done,
    input  wire signed [P_Q_DATA_W-1:0]     i_llr_rd_data,
    output wire                             o_llr_loaded,
    output wire                             o_load_wr_en,
    output wire [P_LLR_ADDR_W-1:0]          o_load_wr_addr,
    output wire signed [P_Q_DATA_W-1:0]     o_load_wr_data,
    output wire                             o_out_active,
    output wire [P_LLR_ADDR_W-1:0]          o_out_addr
);

    //-------------------------------------------------------------
    // 输入 LLR 加载 (红线1: 输入寄存)
    //-------------------------------------------------------------
    reg signed [P_Q_DATA_W-1:0]     ri_llr_data;
    reg [P_LLR_ADDR_W-1:0]          r_llr_load_addr;
    reg                             r_llr_load_done;
    reg                             r_load_wr_en;
    reg [P_LLR_ADDR_W-1:0]          r_load_wr_addr;

    wire w_load_accept = s_axis_llr_tvalid && s_axis_llr_tready;

    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            ri_llr_data     <= {P_Q_DATA_W{1'b0}};
            r_llr_load_addr <= {P_LLR_ADDR_W{1'b0}};
            r_llr_load_done <= 1'b0;
            r_load_wr_en    <= 1'b0;
            r_load_wr_addr  <= {P_LLR_ADDR_W{1'b0}};
        end else begin
            // 握手成立才推进, 并把该拍数据/地址寄存一拍去驱动写口
            ri_llr_data    <= s_axis_llr_tdata;
            r_load_wr_en   <= w_load_accept;
            r_load_wr_addr <= r_llr_load_addr;

            if (w_load_accept) begin
                if (r_llr_load_addr == (P_N - 1)) begin
                    r_llr_load_done <= 1'b1;
                    r_llr_load_addr <= {P_LLR_ADDR_W{1'b0}};
                end else begin
                    r_llr_load_addr <= r_llr_load_addr + 1'b1;
                end
            end

            if (i_busy) r_llr_load_done <= 1'b0;   // 见头注释 1
        end
    end

    assign o_llr_loaded   = r_llr_load_done;
    assign o_load_wr_en   = r_load_wr_en;
    assign o_load_wr_addr = r_load_wr_addr;
    assign o_load_wr_data = ri_llr_data;

    // 见头注释 2
    assign s_axis_llr_tready = ~r_llr_load_done && ~i_busy && ~o_out_active;

    //-------------------------------------------------------------
    // 硬判决输出扫描
    //  每比特走 地址 -> 等数据 -> 保持到被取走 三拍, 严格按 valid/ready 推进。
    //  早前用"读地址随握手推进 + 输出寄存做 skid"的写法, 下游随机撤 tready 时
    //  会错位 (实测 516 拍停顿下 113/324 位不符): 同步读存储器的地址流水与
    //  输出保持是两个节奏, 手写 skid 容易在停顿边界上错开一拍。
    //  代价: 324 位约 972 拍, 相对单码字 ~7e4 拍的译码时间可忽略。
    //-------------------------------------------------------------
    localparam P_OS_IDLE = 2'd0;
    localparam P_OS_ADDR = 2'd1;   // 地址已挂到 llr_buffer
    localparam P_OS_WAIT = 2'd2;   // 同步读数据本拍到位
    localparam P_OS_HOLD = 2'd3;   // 保持 tvalid 直到被取走

    reg                             ro_data;
    reg                             ro_valid;
    reg [P_LLR_ADDR_W-1:0]          r_out_addr;
    reg [1:0]                       r_os;

    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            ro_data    <= 1'b0;
            ro_valid   <= 1'b0;
            r_out_addr <= {P_LLR_ADDR_W{1'b0}};
            r_os       <= P_OS_IDLE;
        end else begin
            case (r_os)
                P_OS_IDLE: begin
                    ro_valid <= 1'b0;
                    if (i_decode_done) begin
                        r_out_addr <= {P_LLR_ADDR_W{1'b0}};
                        r_os       <= P_OS_ADDR;
                    end
                end
                P_OS_ADDR: r_os <= P_OS_WAIT;
                P_OS_WAIT: begin
                    ro_data  <= i_llr_rd_data[P_Q_DATA_W-1];   // 符号位 = 硬判决
                    ro_valid <= 1'b1;
                    r_os     <= P_OS_HOLD;
                end
                P_OS_HOLD: begin
                    if (m_axis_data_tready) begin
                        ro_valid <= 1'b0;
                        if (r_out_addr == (P_K - 1)) begin
                            r_os <= P_OS_IDLE;
                        end else begin
                            r_out_addr <= r_out_addr + 1'b1;
                            r_os       <= P_OS_ADDR;
                        end
                    end
                end
                default: r_os <= P_OS_IDLE;
            endcase
        end
    end

    assign m_axis_data_tdata  = ro_data;
    assign m_axis_data_tvalid = ro_valid;
    assign o_out_active       = (r_os != P_OS_IDLE);
    assign o_out_addr         = r_out_addr;

endmodule
