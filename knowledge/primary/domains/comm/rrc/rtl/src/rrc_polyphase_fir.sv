//==============================================================================
// RRC Polyphase FIR Filter - Core Engine
// Polyphase: 4 phases, symmetric coefficient folding
// I/O: AXI4-Stream (symbol in @ 1MHz, sample out @ 4MHz)
//==============================================================================
module rrc_polyphase_fir #(
    parameter int DATA_W  = 16,
    parameter int COEFF_W = 16,
    parameter int ACC_W   = 38,
    parameter int SPS     = 4,
    parameter int SPAN    = 8
)(
    input  logic                clk,
    input  logic                rst_n,
    input  logic                s_axis_tvalid,
    output logic                s_axis_tready,
    input  logic [DATA_W*2-1:0] s_axis_tdata,
    output logic                m_axis_tvalid,
    input  logic                m_axis_tready,
    output logic [DATA_W*2-1:0] m_axis_tdata
);

    //==========================================================================
    // Coefficient ROM (4 phases, symmetric folded, Q1.15)
    //==========================================================================
    localparam SYM_TAPS = 5;
    typedef logic signed [COEFF_W-1:0] coeff_t;
    coeff_t coeff_rom [SPS][SYM_TAPS];

    initial begin
        coeff_rom[0][0] = 16'h00E4; coeff_rom[0][1] = 16'hFEE0;
        coeff_rom[0][2] = 16'hF51C; coeff_rom[0][3] = 16'h0C36;
        coeff_rom[0][4] = 16'h5A76;
        coeff_rom[1][0] = 16'h0268; coeff_rom[1][1] = 16'hF8D6;
        coeff_rom[1][2] = 16'hF8D6; coeff_rom[1][3] = 16'h1AA8;
        coeff_rom[1][4] = 16'h0000;
        coeff_rom[2][0] = 16'h0512; coeff_rom[2][1] = 16'h0000;
        coeff_rom[2][2] = 16'h0200; coeff_rom[2][3] = 16'h5340;
        coeff_rom[2][4] = 16'h0000;
        coeff_rom[3][0] = 16'h0B5A; coeff_rom[3][1] = 16'h0B5A;
        coeff_rom[3][2] = 16'h10E4; coeff_rom[3][3] = 16'h5F98;
        coeff_rom[3][4] = 16'h0000;
    end

    //==========================================================================
    // Input shift register (span=8 symbols)
    //==========================================================================
    typedef logic signed [DATA_W-1:0] data_t;
    data_t sym_buf_i[0:SPAN-1];
    data_t sym_buf_q[0:SPAN-1];

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            for (int i = 0; i < SPAN; i++) begin
                sym_buf_i[i] <= '0;
                sym_buf_q[i] <= '0;
            end
        end else if (s_axis_tvalid && s_axis_tready) begin
            for (int i = SPAN-1; i > 0; i--) begin
                sym_buf_i[i] <= sym_buf_i[i-1];
                sym_buf_q[i] <= sym_buf_q[i-1];
            end
            sym_buf_i[0] <= data_t'(s_axis_tdata[DATA_W-1:0]);
            sym_buf_q[0] <= data_t'(s_axis_tdata[DATA_W*2-1:DATA_W]);
        end
    end

    //==========================================================================
    // Phase counter (0-3 per symbol period)
    //==========================================================================
    typedef logic [$clog2(SPS)-1:0] phase_t;
    phase_t phase;
    logic   calc_busy;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n)
            phase <= '0;
        else if (s_axis_tvalid && s_axis_tready)
            phase <= '0;
        else if (phase < SPS-1)
            phase <= phase + 1'b1;
    end

    //==========================================================================
    // Polyphase MAC (5 parallel -> 5 DSP48)
    // Stage 1: pre-add (symmetric) + multiply
    // Stage 2: adder tree
    //==========================================================================
    typedef logic signed [ACC_W-1:0] acc_t;
    acc_t mac_i [SYM_TAPS];
    acc_t mac_q [SYM_TAPS];
    acc_t sum_i, sum_q;

    // Pipeline stage 1
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            for (int k = 0; k < SYM_TAPS; k++) begin
                mac_i[k] <= '0;
                mac_q[k] <= '0;
            end
        end else if (s_axis_tvalid && s_axis_tready || (phase != 0)) begin
            for (int k = 0; k < SYM_TAPS; k++) begin
                if (coeff_rom[phase][k] != '0) begin
                    data_t pi, pq;
                    if ((phase == 0) && (k == 4)) begin
                        pi = sym_buf_i[4];
                        pq = sym_buf_q[4];
                    end else begin
                        pi = sym_buf_i[k] + sym_buf_i[SPAN-1-k];
                        pq = sym_buf_q[k] + sym_buf_q[SPAN-1-k];
                    end
                    mac_i[k] <= $signed(pi) * $signed(coeff_rom[phase][k]);
                    mac_q[k] <= $signed(pq) * $signed(coeff_rom[phase][k]);
                end
            end
        end
    end

    // Pipeline stage 2: adder tree
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            sum_i <= '0; sum_q <= '0;
        end else begin
            sum_i <= mac_i[0] + mac_i[1] + mac_i[2] + mac_i[3] + mac_i[4];
            sum_q <= mac_q[0] + mac_q[1] + mac_q[2] + mac_q[3] + mac_q[4];
        end
    end

    //==========================================================================
    // Output: convergent rounding + saturation (Q8.30 -> Q2.14)
    //==========================================================================
    localparam int TRUNC_BITS = 16;
    localparam int SAT_BITS   = 6;
    data_t out_i, out_q;

    always_comb begin
        acc_t ri, rq;
        if (sum_i[TRUNC_BITS-1] && !(&sum_i[TRUNC_BITS-2:0]))
            ri = sum_i + (1 << TRUNC_BITS);
        else if (sum_i[TRUNC_BITS])
            ri = sum_i - (1 << TRUNC_BITS);
        else
            ri = sum_i;

        if (sum_q[TRUNC_BITS-1] && !(&sum_q[TRUNC_BITS-2:0]))
            rq = sum_q + (1 << TRUNC_BITS);
        else if (sum_q[TRUNC_BITS])
            rq = sum_q - (1 << TRUNC_BITS);
        else
            rq = sum_q;

        if (ri[ACC_W-1:ACC_W-SAT_BITS] != {SAT_BITS{ri[ACC_W-1]}})
            out_i = ri[ACC_W-1] ? {1'b1, {(DATA_W-1){1'b0}}} : {1'b0, {(DATA_W-1){1'b1}}};
        else
            out_i = data_t'(ri >>> TRUNC_BITS);

        if (rq[ACC_W-1:ACC_W-SAT_BITS] != {SAT_BITS{rq[ACC_W-1]}})
            out_q = rq[ACC_W-1] ? {1'b1, {(DATA_W-1){1'b0}}} : {1'b0, {(DATA_W-1){1'b1}}};
        else
            out_q = data_t'(rq >>> TRUNC_BITS);
    end

    //==========================================================================
    // AXI4-Stream output control
    //==========================================================================
    logic phase_valid;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n)
            phase_valid <= 1'b0;
        else if (s_axis_tvalid && s_axis_tready)
            phase_valid <= 1'b1;
        else if (m_axis_tvalid && m_axis_tready && (phase >= SPS-1))
            phase_valid <= 1'b0;
    end

    assign m_axis_tdata  = {out_q, out_i};
    assign m_axis_tvalid = phase_valid;
    assign s_axis_tready = 1'b1;

    assign calc_busy = (phase != 0) || (s_axis_tvalid && s_axis_tready);

endmodule : rrc_polyphase_fir
