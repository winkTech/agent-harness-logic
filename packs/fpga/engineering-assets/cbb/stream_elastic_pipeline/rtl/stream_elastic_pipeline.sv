`timescale 1ns/1ps
`default_nettype none

// stream_elastic_pipeline
// One-word elastic stages with ordered valid/ready flow control.
// Contract: docs/requirements.md
module stream_elastic_pipeline #(
    parameter integer DATA_WIDTH = 32,
    parameter integer DEPTH = 2
) (
    input  wire                   i_clk,
    input  wire                   i_rst,
    input  wire [DATA_WIDTH-1:0]  i_tdata,
    input  wire                   i_tvalid,
    output wire                   o_tready,
    output wire [DATA_WIDTH-1:0]  o_tdata,
    output wire                   o_tvalid,
    input  wire                   i_tready
);
    reg [DATA_WIDTH-1:0] r_tdata [0:DEPTH-1];
    reg                  r_tvalid [0:DEPTH-1];
    wire [DEPTH:0]       w_stage_ready;
    integer              ri_stage;

    // A stage can accept a replacement word when it is empty or when its
    // current word will advance toward the output on this edge.
    assign w_stage_ready[DEPTH] = i_tready || !r_tvalid[DEPTH-1];
    genvar g_stage;
    generate
        for (g_stage = 0; g_stage < DEPTH; g_stage = g_stage + 1) begin : gen_ready
            assign w_stage_ready[g_stage] = !r_tvalid[g_stage] || w_stage_ready[g_stage+1];
        end
    endgenerate

    assign o_tready = w_stage_ready[0];
    assign o_tvalid = r_tvalid[DEPTH-1];
    assign o_tdata  = r_tdata[DEPTH-1];

    always @(posedge i_clk) begin
        if (i_rst) begin
            for (ri_stage = 0; ri_stage < DEPTH; ri_stage = ri_stage + 1) begin
                r_tdata[ri_stage]  <= {DATA_WIDTH{1'b0}};
                r_tvalid[ri_stage] <= 1'b0;
            end
        end else begin
            if (w_stage_ready[0]) begin
                r_tvalid[0] <= i_tvalid;
                if (i_tvalid)
                    r_tdata[0] <= i_tdata;
            end
            for (ri_stage = 1; ri_stage < DEPTH; ri_stage = ri_stage + 1) begin
                if (w_stage_ready[ri_stage]) begin
                    r_tvalid[ri_stage] <= r_tvalid[ri_stage-1];
                    if (r_tvalid[ri_stage-1])
                        r_tdata[ri_stage] <= r_tdata[ri_stage-1];
                end
            end
        end
    end
endmodule

`default_nettype wire

