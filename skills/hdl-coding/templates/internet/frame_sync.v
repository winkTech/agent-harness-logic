//-----------------------------------------------------------------
//                         帧同步模块
//-----------------------------------------------------------------
// 功能描述: 以太网帧同步电路
// 应用场景: 网络数据包接收、帧检测
// 算法原理: 检测前导码和SFD，识别帧边界
//-----------------------------------------------------------------
// 输入:
//   i_clk_sys      - 系统时钟
//   i_rst_sys      - 系统复位（高有效）
//   i_data_valid   - 输入数据有效
//   i_data         - 输入数据
// 输出:
//   o_frame_valid  - 帧有效
//   o_sof          - 帧开始
//   o_eof          - 帧结束
//-----------------------------------------------------------------

module frame_sync (
    input  wire        i_clk_sys,
    input  wire        i_rst_sys,
    input  wire        i_data_valid,
    input  wire [7:0]  i_data,
    output reg         o_frame_valid,
    output reg         o_sof,
    output reg         o_eof
);

    //-----------------------------------------------------------------
    // 状态定义
    //-----------------------------------------------------------------
    localparam P_ST_IDLE = 2'b00;
    localparam P_ST_PREAMBLE = 2'b01;
    localparam P_ST_DATA = 2'b10;
    localparam P_ST_CRC = 2'b11;

    reg [1:0] r_state;
    reg [2:0] r_preamble_cnt;

    //-----------------------------------------------------------------
    // 状态机
    //-----------------------------------------------------------------
    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            r_state <= P_ST_IDLE;
            r_preamble_cnt <= 0;
            o_frame_valid <= 0;
            o_sof <= 0;
            o_eof <= 0;
        end else begin
            case (r_state)
                P_ST_IDLE: begin
                    if (i_data_valid && i_data == 8'h55) begin
                        r_state <= P_ST_PREAMBLE;
                        r_preamble_cnt <= 1;
                    end
                end
                P_ST_PREAMBLE: begin
                    if (i_data_valid) begin
                        if (i_data == 8'h55) begin
                            r_preamble_cnt <= r_preamble_cnt + 1;
                        end else if (i_data == 8'hD5) begin
                            r_state <= P_ST_DATA;
                            o_sof <= 1;
                            o_frame_valid <= 1;
                        end else begin
                            r_state <= P_ST_IDLE;
                        end
                    end
                end
                P_ST_DATA: begin
                    o_sof <= 0;
                    if (!i_data_valid) begin
                        r_state <= P_ST_CRC;
                        o_eof <= 1;
                    end
                end
                P_ST_CRC: begin
                    o_eof <= 0;
                    o_frame_valid <= 0;
                    r_state <= P_ST_IDLE;
                end
                default: r_state <= P_ST_IDLE;
            endcase
        end
    end

endmodule
