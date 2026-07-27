//==============================================================================
// Channel Estimation Top - LS estimation + Linear interpolation
// 802.11a OFDM: extracts 4 pilots from FFT output, interpolates to 64 subcarriers
// I/O: AXI4-Stream (Y in, H_est out)
// Latency: 1 OFDM symbol (64 clk capture + 3 clk compute + 64 clk output = 131 clk)
// Pipeline: processes previous symbol during current capture
//==============================================================================
module channel_est_top #(
    parameter int DATA_W = 16
)(
    input  logic                clk,
    input  logic                rst_n,

    // AXI4-Stream slave (Y from FFT)
    input  logic                s_axis_tvalid,
    output logic                s_axis_tready,
    input  logic [DATA_W*2-1:0] s_axis_tdata,

    // AXI4-Stream master (H_est to equalizer)
    output logic                m_axis_tvalid,
    input  logic                m_axis_tready,
    output logic [DATA_W*2-1:0] m_axis_tdata
);

    //==========================================================================
    // Internal signals
    //==========================================================================
    // LS estimator outputs
    logic        ls_symbol_done;
    logic        ls_pilot_valid;
    logic [3:0][DATA_W-1:0] ls_pilot_i;
    logic [3:0][DATA_W-1:0] ls_pilot_q;

    // Interpolator control
    logic        interp_start;
    logic        interp_busy;

    //==========================================================================
    // LS Estimator instance
    //==========================================================================
    ls_estimator #(
        .DATA_W(DATA_W)
    ) u_ls_estimator (
        .clk          (clk),
        .rst_n        (rst_n),
        .s_axis_tvalid(s_axis_tvalid),
        .s_axis_tready(s_axis_tready),
        .s_axis_tdata (s_axis_tdata),
        .pilot_valid  (ls_pilot_valid),
        .pilot_h_i    (ls_pilot_i),
        .pilot_h_q    (ls_pilot_q),
        .symbol_done  (ls_symbol_done)
    );

    //==========================================================================
    // Pipeline control: start interpolator when LS finishes capture
    //==========================================================================
    typedef enum logic [1:0] {WAIT_SYMBOL, COMPUTE_SYMBOL, IDLE} pipe_state_t;
    pipe_state_t pipe_state, pipe_state_nxt;

    always_comb begin
        pipe_state_nxt = pipe_state;
        case (pipe_state)
            IDLE:          if (ls_symbol_done) pipe_state_nxt = WAIT_SYMBOL;
            WAIT_SYMBOL:   if (!interp_busy)   pipe_state_nxt = COMPUTE_SYMBOL;
            COMPUTE_SYMBOL:                    pipe_state_nxt = IDLE;
        endcase
    end

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) pipe_state <= IDLE;
        else        pipe_state <= pipe_state_nxt;
    end

    assign interp_start = (pipe_state == COMPUTE_SYMBOL);

    //==========================================================================
    // Interpolator instance
    //==========================================================================
    channel_interpolator #(
        .DATA_W(DATA_W)
    ) u_interpolator (
        .clk            (clk),
        .rst_n          (rst_n),
        .start          (interp_start),
        .pilot_h_i      (ls_pilot_i),
        .pilot_h_q      (ls_pilot_q),
        .m_axis_tvalid  (m_axis_tvalid),
        .m_axis_tready  (m_axis_tready),
        .m_axis_tdata   (m_axis_tdata)
    );

    assign interp_busy = (u_interpolator.m_axis_tvalid) || (pipe_state == COMPUTE_SYMBOL);

endmodule : channel_est_top
