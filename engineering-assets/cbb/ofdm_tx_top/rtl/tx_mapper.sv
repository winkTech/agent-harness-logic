//==============================================================================
// tx_mapper — 四调制星座映射 (ADR-004; 映射与 golden mod_mapper 逐字对齐)
// 功能: 每拍一个星座符号: i_bits[5:0] (LSB 对齐, BPSK 用 b0 / QPSK b0b1 /
//       16QAM b0..b3 / 64QAM b0..b5, 比特序与 golden mod_mapper 一致:
//       b0=首比特) → (I,Q) Q2.14。
//       Gray 映射 (golden qam_gray_map 同式):
//       4-PAM 00→-3 01→-1 11→+1 10→+3 (÷√10); 8-PAM 000→-7 001→-5 011→-3
//       010→-1 110→+1 111→+3 101→+5 100→+7 (÷√42); QPSK ±1/√2; BPSK ±1。
//       常数 = round(level·16384): ±16384; ±11585; ±{5181,15543};
//       ±{2528,7584,12641,17697} — generate_vectors.m 位真镜像逐字同表。
// 端口: i_clk/i_rst; i_beat/i_valid/i_bits + i_cfg_mod (00 BPSK / 01 QPSK /
//       10 16QAM / 11 64QAM); o_valid/o_re/o_im (滞后 2 拍)
// 复位: 同步高有效, 仅 valid 链复位; 数据级不复位 (§1.1)
//==============================================================================
module tx_mapper #(
    parameter int DATA_W = 16
)(
    input  logic                     i_clk,
    input  logic                     i_rst,       // 同步复位, 高有效
    input  logic                     i_beat,
    input  logic                     i_valid,
    input  logic [5:0]               i_bits,
    input  logic [1:0]               i_cfg_mod,

    output logic                     o_valid,
    output logic signed [DATA_W-1:0] o_re,        // Q2.14
    output logic signed [DATA_W-1:0] o_im
);

    // Gray→电平查表 (索引 = 原始 Gray 比特拼接)
    // 4-PAM: idx {b0,b1}: 00→-3 01→-1 11→+1 10→+3
    localparam logic signed [15:0] P_PAM4 [0:3] = '{
        -16'sd15543, -16'sd5181, 16'sd15543, 16'sd5181
    };
    // 8-PAM: idx {b0,b1,b2}: 000→-7 001→-5 011→-3 010→-1
    //                        110→+1 111→+3 101→+5 100→+7
    localparam logic signed [15:0] P_PAM8 [0:7] = '{
        -16'sd17697, -16'sd12641, -16'sd2528, -16'sd7584,
        16'sd17697,  16'sd12641,  16'sd2528,  16'sd7584
    };

    // 级 1: 输入寄存 (红线 1)
    logic       r_v1;
    logic [5:0] r_bits;
    logic [1:0] r_mod;

    always_ff @(posedge i_clk) begin
        if (i_rst)       r_v1 <= 1'b0;
        else if (i_beat) r_v1 <= i_valid;
    end

    always_ff @(posedge i_clk) begin
        if (i_beat) begin
            r_bits <= i_bits;
            r_mod  <= i_cfg_mod;
        end
    end

    // 级 2: 查表输出 (红线 2)
    logic                     ro_valid;
    logic signed [DATA_W-1:0] ro_re, ro_im;
    logic signed [DATA_W-1:0] w_re, w_im;

    always_comb begin
        case (r_mod)
            2'b00: begin                                  // BPSK: b0
                w_re = r_bits[0] ? 16'sd16384 : -16'sd16384;
                w_im = '0;
            end
            2'b01: begin                                  // QPSK: b0(I), b1(Q)
                w_re = r_bits[0] ? 16'sd11585 : -16'sd11585;
                w_im = r_bits[1] ? 16'sd11585 : -16'sd11585;
            end
            2'b10: begin                                  // 16QAM: b0b1(I), b2b3(Q)
                w_re = P_PAM4[{r_bits[0], r_bits[1]}];
                w_im = P_PAM4[{r_bits[2], r_bits[3]}];
            end
            default: begin                                // 64QAM: b0b1b2(I), b3b4b5(Q)
                w_re = P_PAM8[{r_bits[0], r_bits[1], r_bits[2]}];
                w_im = P_PAM8[{r_bits[3], r_bits[4], r_bits[5]}];
            end
        endcase
    end

    always_ff @(posedge i_clk) begin
        if (i_rst)       ro_valid <= 1'b0;
        else if (i_beat) ro_valid <= r_v1;
    end

    always_ff @(posedge i_clk) begin
        if (i_beat) begin
            ro_re <= w_re;
            ro_im <= w_im;
        end
    end

    assign o_valid = ro_valid;
    assign o_re    = ro_re;
    assign o_im    = ro_im;

endmodule : tx_mapper
