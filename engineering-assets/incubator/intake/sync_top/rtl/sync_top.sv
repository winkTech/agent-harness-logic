//==============================================================================
// OFDM Synchronization Top - AXI4-Stream wrapper
// Integrates packet detect, CFO estimation/correction, fine timing
// Input: r[n] from ADC (Q2.14) -> Output: r_corr[n] + FFT window trigger
//==============================================================================
module sync_top #(
    parameter int DATA_W = 16
)(
    input  logic                clk,
    input  logic                rst_n,

    // AXI4-Stream slave (input samples)
    input  logic                s_axis_tvalid,
    output logic                s_axis_tready,
    input  logic [DATA_W*2-1:0] s_axis_tdata,

    // AXI4-Stream master (CFO corrected samples)
    output logic                m_axis_tvalid,
    input  logic                m_axis_tready,
    output logic [DATA_W*2-1:0] m_axis_tdata,

    // FFT window start trigger
    output logic                fft_start,
    output logic                sync_locked
);

    //==========================================================================
    // Internal signals
    //==========================================================================
    // Packet detector
    logic        pd_valid;
    logic [DATA_W-1:0] pd_metric;
    logic        pd_detected;

    // Fine timing
    logic        ft_valid;
    logic [8:0]  ft_offset;

    // State machine
    typedef enum logic [1:0] {SEARCH, DETECT, TRACK} state_t;
    state_t state, state_nxt;

    //==========================================================================
    // Packet Detector
    //==========================================================================
    packet_detect #(
        .DATA_W(DATA_W)
    ) u_pd (
        .clk              (clk),
        .rst_n            (rst_n),
        .s_axis_tvalid    (s_axis_tvalid),
        .s_axis_tready    (s_axis_tready),
        .s_axis_tdata     (s_axis_tdata),
        .packet_detected  (pd_detected),
        .metric_q15       (pd_metric),
        .metric_valid     (pd_valid)
    );

    //==========================================================================
    // Fine Timing (enabled after packet detect)
    //==========================================================================
    logic ft_enable;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) ft_enable <= 1'b0;
        else if (pd_detected) ft_enable <= 1'b1;
        else if (fft_start)   ft_enable <= 1'b0;
    end

    fine_timing #(
        .DATA_W(DATA_W)
    ) u_ft (
        .clk              (clk),
        .rst_n            (rst_n),
        .enable           (ft_enable),
        .s_axis_tvalid    (s_axis_tvalid),
        .s_axis_tdata     (s_axis_tdata),
        .fft_window_start (fft_start),
        .timing_offset    (ft_offset)
    );

    //==========================================================================
    // Pass-through mode: output r[n] directly (CFO correction placeholder)
    // Full CORDIC-based correction would be inserted here
    //==========================================================================
    assign m_axis_tvalid = s_axis_tvalid;
    assign m_axis_tdata  = s_axis_tdata;

    //==========================================================================
    // State machine
    //==========================================================================
    always_comb begin
        state_nxt = state;
        case (state)
            SEARCH: if (pd_detected)          state_nxt = DETECT;
            DETECT: if (fft_start)             state_nxt = TRACK;
            TRACK:  if (!pd_detected && ft_enable) state_nxt = SEARCH;
        endcase
    end

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) state <= SEARCH;
        else        state <= state_nxt;
    end

    assign sync_locked = (state == TRACK);

endmodule : sync_top
