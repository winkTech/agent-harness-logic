// ============================================================================
// <模块名称>
// 功能: <功能描述>
// 接口: AXI4-Stream
// ============================================================================

`timescale 1ns / 1ps

module <module_name> #(
    parameter DATA_WIDTH = 16,
    parameter USER_WIDTH = 1
) (
    input  wire                  clk,
    input  wire                  rst_n,

    // Slave interface (input)
    input  wire [DATA_WIDTH-1:0] s_axis_tdata,
    input  wire                  s_axis_tvalid,
    output wire                  s_axis_tready,
    input  wire                  s_axis_tlast,

    // Master interface (output)
    output wire [DATA_WIDTH-1:0] m_axis_tdata,
    output wire                  m_axis_tvalid,
    input  wire                  m_axis_tready,
    output wire                  m_axis_tlast,

    // Control
    input  wire                  enable
);

    // ========================================================================
    // Internal signals
    // ========================================================================
    reg [DATA_WIDTH-1:0] data_reg;
    reg                  valid_reg;
    reg                  tlast_reg;

    // ========================================================================
    // Pipeline stage 1
    // ========================================================================
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            data_reg  <= {DATA_WIDTH{1'b0}};
            valid_reg <= 1'b0;
            tlast_reg <= 1'b0;
        end else if (s_axis_tvalid && s_axis_tready) begin
            data_reg  <= s_axis_tdata;  // TODO: processing logic
            valid_reg <= 1'b1;
            tlast_reg <= s_axis_tlast;
        end else if (m_axis_tready) begin
            valid_reg <= 1'b0;
        end
    end

    // ========================================================================
    // Output assignments
    // ========================================================================
    assign s_axis_tready = enable && m_axis_tready;
    assign m_axis_tdata  = data_reg;
    assign m_axis_tvalid = valid_reg;
    assign m_axis_tlast  = tlast_reg;

endmodule
