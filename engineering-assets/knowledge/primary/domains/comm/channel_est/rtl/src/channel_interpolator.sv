//==============================================================================
// Channel Interpolator - Linear interpolation between pilot subcarriers
// Implements 802.11a pilot interpolation with accumulator-based engine
//==============================================================================
module channel_interpolator #(
    parameter int N_FFT   = 64,
    parameter int N_PILOT = 4,
    parameter int DATA_W  = 16
)(
    input  logic                clk,
    input  logic                rst_n,
    input  logic                start,
    input  logic [N_PILOT-1:0][DATA_W-1:0] pilot_h_i,
    input  logic [N_PILOT-1:0][DATA_W-1:0] pilot_h_q,
    output logic                m_axis_tvalid,
    input  logic                m_axis_tready,
    output logic [DATA_W*2-1:0] m_axis_tdata
);
    localparam PILOT_POS_0 = 11;
    localparam PILOT_POS_1 = 25;
    localparam PILOT_POS_2 = 39;
    localparam PILOT_POS_3 = 53;
    localparam COEFF_114 = 4681;  // Q0.16: round(2^16/14)

    typedef logic signed [DATA_W-1:0] data_t;

    typedef enum logic [1:0] {IDLE, COMPUTE, OUTPUT, DONE} state_t;
    state_t state, state_nxt;
    logic [$clog2(N_FFT)-1:0] out_cnt;
    logic [$clog2(N_PILOT)-1:0] slope_phase;

    // Slope pipelined computation
    logic signed [DATA_W+1:0] delta_i, delta_q;
    logic signed [DATA_W+15:0] prod_i, prod_q;
    logic signed [DATA_W+1:0] slope_i [3];
    logic signed [DATA_W+1:0] slope_q [3];

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) slope_phase <= '0;
        else if (state == COMPUTE && slope_phase < 2) slope_phase <= slope_phase + 1;
        else if (state != COMPUTE) slope_phase <= '0;
    end

    always_ff @(posedge clk) begin
        unique case (slope_phase)
            0: begin delta_i <= $signed(pilot_h_i[1]) - $signed(pilot_h_i[0]); delta_q <= $signed(pilot_h_q[1]) - $signed(pilot_h_q[0]); end
            1: begin delta_i <= $signed(pilot_h_i[2]) - $signed(pilot_h_i[1]); delta_q <= $signed(pilot_h_q[2]) - $signed(pilot_h_q[1]); end
            2: begin delta_i <= $signed(pilot_h_i[3]) - $signed(pilot_h_i[2]); delta_q <= $signed(pilot_h_q[3]) - $signed(pilot_h_q[2]); end
            default: begin delta_i <= '0; delta_q <= '0; end
        endcase
    end

    always_ff @(posedge clk) begin
        prod_i <= delta_i * COEFF_114;
        prod_q <= delta_q * COEFF_114;
    end

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            slope_i[0] <= '0; slope_q[0] <= '0;
            slope_i[1] <= '0; slope_q[1] <= '0;
            slope_i[2] <= '0; slope_q[2] <= '0;
        end else if (state == COMPUTE) begin
            slope_i[slope_phase] <= prod_i[29:14] + (prod_i[13] ? 1 : 0);
            slope_q[slope_phase] <= prod_q[29:14] + (prod_q[13] ? 1 : 0);
        end
    end

    // Output accumulator
    data_t out_i, out_q, acc_i, acc_q;
    logic gap0, gap1, gap2;
    assign gap0 = (out_cnt > PILOT_POS_0 && out_cnt < PILOT_POS_1);
    assign gap1 = (out_cnt > PILOT_POS_1 && out_cnt < PILOT_POS_2);
    assign gap2 = (out_cnt > PILOT_POS_2 && out_cnt < PILOT_POS_3);

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin acc_i <= '0; acc_q <= '0; end
        else if (state == OUTPUT && m_axis_tready) begin
            if      (out_cnt == PILOT_POS_0) begin acc_i <= pilot_h_i[0]; acc_q <= pilot_h_q[0]; end
            else if (gap0) begin acc_i <= data_t'($signed(acc_i) + $signed(slope_i[0])); acc_q <= data_t'($signed(acc_q) + $signed(slope_q[0])); end
            else if (out_cnt == PILOT_POS_1) begin acc_i <= pilot_h_i[1]; acc_q <= pilot_h_q[1]; end
            else if (gap1) begin acc_i <= data_t'($signed(acc_i) + $signed(slope_i[1])); acc_q <= data_t'($signed(acc_q) + $signed(slope_q[1])); end
            else if (out_cnt == PILOT_POS_2) begin acc_i <= pilot_h_i[2]; acc_q <= pilot_h_q[2]; end
            else if (gap2) begin acc_i <= data_t'($signed(acc_i) + $signed(slope_i[2])); acc_q <= data_t'($signed(acc_q) + $signed(slope_q[2])); end
            else if (out_cnt == PILOT_POS_3) begin acc_i <= pilot_h_i[3]; acc_q <= pilot_h_q[3]; end
        end
    end

    always_comb begin
        unique case (1)
            out_cnt == 32: begin out_i = data_t'(1 << 14); out_q = '0; end
            out_cnt <= PILOT_POS_0: begin out_i = pilot_h_i[0]; out_q = pilot_h_q[0]; end
            out_cnt == PILOT_POS_1: begin out_i = pilot_h_i[1]; out_q = pilot_h_q[1]; end
            out_cnt == PILOT_POS_2: begin out_i = pilot_h_i[2]; out_q = pilot_h_q[2]; end
            out_cnt == PILOT_POS_3: begin out_i = pilot_h_i[3]; out_q = pilot_h_q[3]; end
            out_cnt > PILOT_POS_3: begin out_i = pilot_h_i[3]; out_q = pilot_h_q[3]; end
            default: begin out_i = acc_i; out_q = acc_q; end
        endcase
    end

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) out_cnt <= '0;
        else if (state == OUTPUT && m_axis_tready) begin
            if (out_cnt == N_FFT-1) out_cnt <= '0;
            else out_cnt <= out_cnt + 1;
        end else if (state != OUTPUT) out_cnt <= '0;
    end

    always_comb begin
        state_nxt = state;
        unique case (state)
            IDLE:    if (start) state_nxt = COMPUTE;
            COMPUTE: if (slope_phase == 2) state_nxt = OUTPUT;
            OUTPUT:  if (m_axis_tready && out_cnt == N_FFT-1) state_nxt = DONE;
            DONE:    state_nxt = IDLE;
        endcase
    end

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) state <= IDLE;
        else state <= state_nxt;
    end

    assign m_axis_tvalid = (state == OUTPUT);
    assign m_axis_tdata  = {out_q, out_i};
endmodule : channel_interpolator
