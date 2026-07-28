`default_nettype none

module stream_elastic_pipeline_sva #(
    parameter int DATA_WIDTH = 32
) (
    input wire                  i_clk,
    input wire                  i_rst,
    input wire [DATA_WIDTH-1:0] i_tdata,
    input wire                  i_tvalid,
    input wire                  o_tready,
    input wire [DATA_WIDTH-1:0] o_tdata,
    input wire                  o_tvalid,
    input wire                  i_tready
);
    default clocking cb @(posedge i_clk); endclocking

    property p_output_stable_under_backpressure;
        disable iff (i_rst)
        o_tvalid && !i_tready |=> o_tvalid && $stable(o_tdata);
    endproperty
    a_output_stable_under_backpressure: assert property (p_output_stable_under_backpressure)
        else $error("stream_elastic_pipeline changed output while stalled");

    property p_valid_held_until_transfer;
        disable iff (i_rst)
        o_tvalid && !i_tready |=> o_tvalid;
    endproperty
    a_valid_held_until_transfer: assert property (p_valid_held_until_transfer)
        else $error("stream_elastic_pipeline dropped valid before transfer");

    property p_reset_flushes_valid;
        i_rst |=> !o_tvalid;
    endproperty
    a_reset_flushes_valid: assert property (p_reset_flushes_valid)
        else $error("stream_elastic_pipeline retained valid after reset");

    c_output_transfer: cover property (o_tvalid && i_tready);
    c_input_stall: cover property (i_tvalid && !o_tready);

endmodule

`default_nettype wire
