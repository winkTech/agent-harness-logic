//==============================================================================
// LS Estimator - Pilot extraction for OFDM channel estimation
// Extracts pilots from FFT output, applies LS (sign selection for BPSK)
// I/O: AXI4-Stream (Y in @ 100 MHz, 64 subcarriers/symbol)
//==============================================================================
module ls_estimator #(
    parameter int N_FFT   = 64,
    parameter int N_PILOT = 4,
    parameter int DATA_W  = 16
)(
    input  logic                clk,
    input  logic                rst_n,

    // FFT output (AXI4-Stream slave)
    input  logic                s_axis_tvalid,
    output logic                s_axis_tready,
    input  logic [DATA_W*2-1:0] s_axis_tdata,

    // Pilot output (4 complex values)
    output logic                pilot_valid,
    output logic [N_PILOT-1:0][DATA_W-1:0] pilot_h_i,
    output logic [N_PILOT-1:0][DATA_W-1:0] pilot_h_q,

    // Symbol boundary
    output logic                symbol_done
);

    //==========================================================================
    // Pilot positions (0-based, after FFT)
    // 802.11a: pilots at subcarriers {-21,-7,7,21} mapped to indices
    //==========================================================================
    localparam int PILOT_POS[N_PILOT] = '{11, 25, 39, 53};

    //==========================================================================
    // Internal state
    //==========================================================================
    typedef enum logic [1:0] {IDLE, CAPTURE, DONE} state_t;
    state_t state, state_nxt;

    logic [(N_FFT)-1:0] sub_idx;
    logic [(N_PILOT)-1:0] pilot_cnt;
    logic all_pilots_captured;

    //==========================================================================
    // Subcarrier index counter
    //==========================================================================
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n)
            sub_idx <= '0;
        else if (state == CAPTURE && s_axis_tvalid && s_axis_tready) begin
            if (sub_idx == N_FFT-1)
                sub_idx <= '0;
            else
                sub_idx <= sub_idx + 1'b1;
        end else if (state != CAPTURE) begin
            sub_idx <= '0;
        end
    end

    //==========================================================================
    // Pilot capture
    //==========================================================================
    logic pilot_match;
    assign pilot_match = (state == CAPTURE) && s_axis_tvalid && s_axis_tready &&
                         (sub_idx inside {PILOT_POS[0], PILOT_POS[1], PILOT_POS[2], PILOT_POS[3]});

    // AXI4-Stream BPSK pilot sequence [1, 1, -1, 1]
    // +1 ¡ú pass through, -1 ¡ú negate
    logic neg_pilot;
    assign neg_pilot = (sub_idx == PILOT_POS[2]);  // only pilot 2 is -1

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            for (int p = 0; p < N_PILOT; p++) begin
                pilot_h_i[p] <= '0;
                pilot_h_q[p] <= '0;
            end
            pilot_cnt <= '0;
        end else if (pilot_match) begin
            if (neg_pilot) begin
                pilot_h_i[pilot_cnt] <= -(s_axis_tdata[DATA_W-1:0]);
                pilot_h_q[pilot_cnt] <= -(s_axis_tdata[DATA_W*2-1:DATA_W]);
            end else begin
                pilot_h_i[pilot_cnt] <= s_axis_tdata[DATA_W-1:0];
                pilot_h_q[pilot_cnt] <= s_axis_tdata[DATA_W*2-1:DATA_W];
            end
            pilot_cnt <= pilot_cnt + 1'b1;
        end
    end

    assign all_pilots_captured = (pilot_cnt == N_PILOT);

    //==========================================================================
    // State machine
    //==========================================================================
    always_comb begin
        state_nxt = state;
        case (state)
            IDLE: begin
                if (s_axis_tvalid && s_axis_tready)
                    state_nxt = CAPTURE;
            end
            CAPTURE: begin
                if (s_axis_tvalid && s_axis_tready && (sub_idx == N_FFT-1))
                    state_nxt = DONE;
            end
            DONE: begin
                state_nxt = IDLE;
            end
        endcase
    end

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n)
            state <= IDLE;
        else
            state <= state_nxt;
    end

    //==========================================================================
    // Output control
    //==========================================================================
    assign s_axis_tready = (state == IDLE) || (state == CAPTURE);
    assign pilot_valid   = pilot_match;
    assign symbol_done   = (state == DONE);

endmodule : ls_estimator
