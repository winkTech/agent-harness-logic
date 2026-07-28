`timescale 1ns/1ps
`default_nettype none

// pulse_merge — normalized local implementation of the MIT reference behavior.
// Upstream source: engineering-assets/reference-assets/vendor/verilog-pcie-master/rtl/pulse_merge.v
// License/provenance: docs/LICENSE-MIT.txt and docs/provenance.json
module pulse_merge #(
    parameter integer INPUT_WIDTH = 2,
    parameter integer COUNT_WIDTH = 4
) (
    input  wire                    i_clk,
    input  wire                    i_rst,
    input  wire [INPUT_WIDTH-1:0]  i_pulse_in,
    output wire [COUNT_WIDTH-1:0]  o_count_out,
    output wire                    o_pulse_out
);
    reg [COUNT_WIDTH-1:0] r_count;
    reg [COUNT_WIDTH-1:0] r_count_next;
    reg                   r_pulse;
    reg                   r_pulse_next;
    integer               ri_input;

    always @* begin
        r_count_next = r_count;
        r_pulse_next = (r_count != {COUNT_WIDTH{1'b0}});
        if (r_count != {COUNT_WIDTH{1'b0}})
            r_count_next = r_count - {{(COUNT_WIDTH-1){1'b0}}, 1'b1};
        for (ri_input = 0; ri_input < INPUT_WIDTH; ri_input = ri_input + 1)
            r_count_next = r_count_next + i_pulse_in[ri_input];
    end

    always @(posedge i_clk) begin
        if (i_rst) begin
            r_count <= {COUNT_WIDTH{1'b0}};
            r_pulse <= 1'b0;
        end else begin
            r_count <= r_count_next;
            r_pulse <= r_pulse_next;
        end
    end

    assign o_count_out = r_count;
    assign o_pulse_out = r_pulse;
endmodule

`default_nettype wire

