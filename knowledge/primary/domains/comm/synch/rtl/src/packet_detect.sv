//==============================================================================
// Packet Detector - Sliding window auto-correlation
// Delay = 16 (short preamble period), window = 16
// Division-free threshold comparison: |C|^2 > (thresh * P)^2
//==============================================================================
module packet_detect #(
    parameter int DATA_W = 16,
    parameter int ACC_W  = 32,
    parameter int N_SHORT = 16,
    parameter int L_CORR  = 16
)(
    input  logic                clk,
    input  logic                rst_n,
    input  logic                s_axis_tvalid,
    output logic                s_axis_tready,
    input  logic [DATA_W*2-1:0] s_axis_tdata,
    output logic                packet_detected,
    output logic [DATA_W-1:0]   metric_q15,
    output logic                metric_valid
);

    typedef logic signed [DATA_W-1:0] data_t;
    typedef logic signed [ACC_W-1:0]  acc_t;

    // Delay line: 32 samples (N_SHORT + L_CORR)
    data_t dl_i [0:N_SHORT+L_CORR];
    data_t dl_q [0:N_SHORT+L_CORR];

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            for (int k = 0; k <= N_SHORT+L_CORR; k++) begin
                dl_i[k] <= '0; dl_q[k] <= '0;
            end
        end else if (s_axis_tvalid) begin
            dl_i[0] <= data_t'(s_axis_tdata[DATA_W-1:0]);
            dl_q[0] <= data_t'(s_axis_tdata[DATA_W*2-1:DATA_W]);
            for (int k = 1; k <= N_SHORT+L_CORR; k++) begin
                dl_i[k] <= dl_i[k-1]; dl_q[k] <= dl_q[k-1];
            end
        end
    end

    // Product: r[n] * conj(r[n-16])
    logic signed [DATA_W*2-1:0] p_i, p_q;

    always_ff @(posedge clk) begin
        if (s_axis_tvalid) begin
            p_i <= $signed(dl_i[0]) * $signed(dl_i[N_SHORT])
                 + $signed(dl_q[0]) * $signed(dl_q[N_SHORT]);
            p_q <= $signed(dl_q[0]) * $signed(dl_i[N_SHORT])
                 - $signed(dl_i[0]) * $signed(dl_q[N_SHORT]);
        end
    end

    // Product delay line (L_CORR deep for sliding window)
    logic signed [DATA_W*2-1:0] pd_i [0:L_CORR];
    logic signed [DATA_W*2-1:0] pd_q [0:L_CORR];

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            for (int k = 0; k <= L_CORR; k++) begin
                pd_i[k] <= '0; pd_q[k] <= '0;
            end
        end else if (s_axis_tvalid) begin
            pd_i[0] <= p_i; pd_q[0] <= p_q;
            for (int k = 1; k <= L_CORR; k++) begin
                pd_i[k] <= pd_i[k-1]; pd_q[k] <= pd_q[k-1];
            end
        end
    end

    // Sliding accumulator: C[n] += new - old
    acc_t acc_i, acc_q;
    logic signed [DATA_W*2-1:0] energy;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            acc_i <= '0; acc_q <= '0; energy <= '0;
        end else if (s_axis_tvalid) begin
            acc_i <= acc_i + p_i - pd_i[L_CORR];
            acc_q <= acc_q + p_q - pd_q[L_CORR];
            // Energy = |r(n-16)|^2
            energy <= energy
                + ($signed(dl_i[N_SHORT]) * $signed(dl_i[N_SHORT])
                 + $signed(dl_q[N_SHORT]) * $signed(dl_q[N_SHORT]))
                - ($signed(dl_i[N_SHORT+L_CORR]) * $signed(dl_i[N_SHORT+L_CORR])
                 + $signed(dl_q[N_SHORT+L_CORR]) * $signed(dl_q[N_SHORT+L_CORR]));
        end
    end

    // Threshold: |C|^2 > (0.5 * P)^2
    localparam int TH_Q = 16384;  // 0.5 in Q0.15
    logic signed [ACC_W*2-1:0] c2, se;

    always_ff @(posedge clk) begin
        c2 <= $signed(acc_i) * $signed(acc_i)
            + $signed(acc_q) * $signed(acc_q);
        se <= (TH_Q * $signed(energy)) * (TH_Q * $signed(energy));
    end

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) packet_detected <= 1'b0;
        else if (c2 > (se >>> 30) && $signed(energy) > 0)
            packet_detected <= 1'b1;
        else packet_detected <= 1'b0;
    end

    // Metric = |C|^2 / P^2 (approximate, Q0.15)
    logic [DATA_W-1:0] mtr;
    always_ff @(posedge clk) begin
        if ($signed(energy) > 0)
            mtr <= c2[ACC_W+DATA_W-1:ACC_W-DATA_W+1];
        else mtr <= '0;
    end

    assign metric_q15 = mtr;
    assign metric_valid = s_axis_tvalid;
    assign s_axis_tready = 1'b1;

endmodule : packet_detect
