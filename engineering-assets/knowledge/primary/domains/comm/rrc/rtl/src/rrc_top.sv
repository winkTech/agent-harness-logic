//==============================================================================
// RRC Pulse Shaping Filter - Top Level
// 4x polyphase interpolating FIR with AXI4-Stream I/O
// Alpha=0.5, SPS=4, Span=8, 33 taps
//==============================================================================
module rrc_top #(
    parameter int DATA_W = 16
)(
    input  logic         clk,
    input  logic         rst_n,
    input  logic         s_axis_tvalid,
    output logic         s_axis_tready,
    input  logic [31:0]  s_axis_tdata,
    output logic         m_axis_tvalid,
    input  logic         m_axis_tready,
    output logic [31:0]  m_axis_tdata,
    input  logic [7:0]   alpha_sel
);

    logic        core_tvalid, core_tready;
    logic [31:0] core_tdata;

    // Input register slice
    logic        s_valid_r;
    logic [31:0] s_data_r;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            s_valid_r <= 1'b0;
            s_data_r  <= '0;
        end else begin
            if (s_axis_tready) begin
                s_valid_r <= s_axis_tvalid;
                s_data_r  <= s_axis_tdata;
            end
        end
    end

    assign s_axis_tready = ~s_valid_r || (s_valid_r && core_tvalid && core_tready);

    // Polyphase FIR Core
    rrc_polyphase_fir #(
        .DATA_W (DATA_W), .SPS (4), .SPAN (8)
    ) u_fir (
        .clk            (clk),
        .rst_n          (rst_n),
        .s_axis_tvalid  (s_valid_r),
        .s_axis_tready  (core_tready),
        .s_axis_tdata   (s_data_r),
        .m_axis_tvalid  (core_tvalid),
        .m_axis_tready  (m_axis_tready),
        .m_axis_tdata   (core_tdata)
    );

    // Output register slice
    logic        m_valid_r;
    logic [31:0] m_data_r;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n)
            m_valid_r <= 1'b0;
        else if (core_tvalid && core_tready) begin
            m_valid_r <= 1'b1;
            m_data_r  <= core_tdata;
        end else if (m_axis_tready)
            m_valid_r <= 1'b0;
    end

    assign m_axis_tvalid = m_valid_r;
    assign m_axis_tdata  = m_data_r;

endmodule : rrc_top
