//==============================================================================
// Fine Timing - Long preamble cross-correlation + peak detection
// Correlates received signal with known T1 sequence (64 taps)
//==============================================================================
module fine_timing #(
    parameter int DATA_W  = 16,
    parameter int ACC_W   = 32,
    parameter int N_LONG  = 64
)(
    input  logic                clk,
    input  logic                rst_n,
    input  logic                enable,
    input  logic                s_axis_tvalid,
    input  logic [DATA_W*2-1:0] s_axis_tdata,
    output logic                fft_window_start,  // FFT capture trigger
    output logic [$clog2(512)-1:0] timing_offset    // timing offset for debug
);

    typedef logic signed [DATA_W-1:0] data_t;
    typedef logic signed [ACC_W-1:0]  acc_t;
    // 相关累加器类型: 64 个 32 位积求和, 需与 corr_sum/w_corr_comb 同宽,
    // 转型加宽后再累加, 防止 DATA_W*2 积宽被截断。
    typedef logic signed [ACC_W*2-1:0] corr_t;

    // T1 sequence coefficients (Q1.15, from 802.11a long preamble)
    // 53 non-zero BPSK values in frequency domain -> time domain
    localparam data_t T1_COEFF_I [0:N_LONG-1] = '{
        -192,  -419,   393,   420,    65,   -15,  -213,  -647,
          98,   865,   459,  -186,  -294,  -512,   179,   789,
         204,  -396,  -174,  -137,   244,   206,  -237,  -335,
          89,   628,   511,  -123,  -420,  -304,   238,   740,
         368,  -342,  -543,   112,   676,   397,  -297,  -529,
        -138,   520,   560,  -108,  -649,  -413,   282,   556,
         137,  -482,  -382,   247,   657,   298,  -369,  -279,
         117,   649,   329,  -319,  -397,     5,   379,   175
    };
    localparam data_t T1_COEFF_Q [0:N_LONG-1] = '{
         -32,    83,   250,   418,   454,   337,   133,  -111,
        -316,  -400,  -362,  -218,   -15,   192,   344,   401,
         362,   253,   109,   -33,  -133,  -171,  -154,   -98,
         -26,    31,    48,    28,   -17,   -71,  -110,  -114,
         -80,   -21,    43,    94,   114,   103,    70,    32,
           2,   -15,   -17,   -13,   -14,   -24,   -40,   -53,
         -52,   -32,     1,    38,    64,    65,    39,    -6,
         -52,   -80,   -77,   -44,     4,    49,    70,    59
    };

    // Shift register for received samples
    data_t sr_i [0:N_LONG-1];
    data_t sr_q [0:N_LONG-1];

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            for (int k = 0; k < N_LONG; k++) begin
                sr_i[k] <= '0; sr_q[k] <= '0;
            end
        end else if (s_axis_tvalid) begin
            sr_i[0] <= data_t'(s_axis_tdata[DATA_W-1:0]);
            sr_q[0] <= data_t'(s_axis_tdata[DATA_W*2-1:DATA_W]);
            for (int k = 1; k < N_LONG; k++) begin
                sr_i[k] <= sr_i[k-1]; sr_q[k] <= sr_q[k-1];
            end
        end
    end

    // Multiplier tree for correlation
    logic signed [DATA_W*2-1:0] mul_i [0:N_LONG-1];
    logic signed [DATA_W*2-1:0] mul_q [0:N_LONG-1];
    logic signed [ACC_W*2-1:0]  corr_sum;

    always_ff @(posedge clk) begin
        if (s_axis_tvalid) begin
            for (int k = 0; k < N_LONG; k++) begin
                // Complex multiplication: r * conj(T1)
                mul_i[k] <= $signed(sr_i[k]) * $signed(T1_COEFF_I[k])
                          + $signed(sr_q[k]) * $signed(T1_COEFF_Q[k]);
                mul_q[k] <= $signed(sr_q[k]) * $signed(T1_COEFF_I[k])
                          - $signed(sr_i[k]) * $signed(T1_COEFF_Q[k]);
            end
        end
    end

    // Adder tree (3 levels for 64 inputs)
    always_ff @(posedge clk) begin
        // Level 1: sum of 4 -> 16 sums
        // Level 2: sum of 4 -> 4 sums
        // Level 3: sum of 4 -> 1 sum
    end

    // Combinational adder tree + register
    // FIXED (2026-06-03): Non-blocking assignment loop (corr_sum <= corr_sum + ...)
    // only kept the LAST iteration in SystemVerilog. Changed to combinational
    // accumulation with blocking =, then register the result.
    logic signed [ACC_W*2-1:0] w_corr_comb;
    always_comb begin
        w_corr_comb = '0;
        for (int k = 0; k < N_LONG; k++)
            w_corr_comb = w_corr_comb + corr_t'($signed(mul_i[k]));
    end

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n)
            corr_sum <= '0;
        else if (s_axis_tvalid)
            corr_sum <= w_corr_comb;
    end

    // Peak detection
    logic signed [ACC_W*2-1:0] r_peak_val;
    logic [$clog2(512)-1:0] r_sample_cnt, r_peak_pos;

    always_ff @(posedge clk) begin
        if (!rst_n) begin
            r_peak_val <= '0; r_peak_pos <= '0;
            r_sample_cnt <= '0; fft_window_start <= 1'b0;
        end else begin
            if (enable && s_axis_tvalid) begin
                r_sample_cnt <= r_sample_cnt + 1;
                if (corr_sum > r_peak_val) begin
                    r_peak_val <= corr_sum;
                    r_peak_pos <= r_sample_cnt;
                end
            end else if (!enable) begin
                r_peak_val  <= '0; r_peak_pos  <= '0;
                r_sample_cnt <= '0; fft_window_start <= 1'b0;
            end
        end
    end

    assign timing_offset = r_peak_pos;

endmodule : fine_timing
