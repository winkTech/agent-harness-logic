`default_nettype none

module pulse_merge_sva #(
    parameter integer COUNT_WIDTH = 8
) (
    input wire                    i_clk,
    input wire                    i_rst,
    input wire [COUNT_WIDTH-1:0]  o_count_out,
    input wire                    o_pulse_out
);
    default clocking cb @(posedge i_clk); endclocking

    property p_reset_flushes_state;
        i_rst |=> (o_count_out == {COUNT_WIDTH{1'b0}} && !o_pulse_out);
    endproperty
    a_reset_flushes_state: assert property (p_reset_flushes_state)
        else $error("pulse_merge retained state after reset");

    property p_pulse_reports_previous_count;
        disable iff (i_rst)
        (o_pulse_out == ($past(o_count_out) != {COUNT_WIDTH{1'b0}})) || $past(i_rst);
    endproperty
    a_pulse_reports_previous_count: assert property (p_pulse_reports_previous_count)
        else $error("pulse_merge pulse status is not the previous count status");

    c_credit_present: cover property (o_count_out != {COUNT_WIDTH{1'b0}});

endmodule

`default_nettype wire
