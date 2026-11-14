`timescale 1ns/1ps
`default_nettype none

module tb_pulse_merge #(
    parameter integer INPUT_WIDTH = 4,
    parameter integer COUNT_WIDTH = 12,
    parameter integer MAX_CYCLES = 1000,
    parameter integer SEED = 32'h0000C0DE
);
    reg i_clk = 1'b0;
    reg i_rst = 1'b1;
    reg [INPUT_WIDTH-1:0] i_pulse_in = {INPUT_WIDTH{1'b0}};
    wire [COUNT_WIDTH-1:0] o_count_out;
    wire o_pulse_out;
    integer cycle;
    integer seed;
    integer failures;
    integer old_count;
    integer expected_count;
    reg expected_pulse;
    integer choice;
    integer bit_index;

    always #5 i_clk = ~i_clk;

    pulse_merge #(
        .INPUT_WIDTH(INPUT_WIDTH),
        .COUNT_WIDTH(COUNT_WIDTH)
    ) dut (
        .i_clk(i_clk), .i_rst(i_rst), .i_pulse_in(i_pulse_in),
        .o_count_out(o_count_out), .o_pulse_out(o_pulse_out)
    );

`ifdef PULSE_MERGE_SVA
    pulse_merge_sva #(.COUNT_WIDTH(COUNT_WIDTH)) assertions (
        .i_clk(i_clk), .i_rst(i_rst), .o_count_out(o_count_out), .o_pulse_out(o_pulse_out)
    );
`endif

    task automatic check;
        begin
            if (i_rst) begin
                expected_count = 0;
                expected_pulse = 1'b0;
            end else begin
                old_count = expected_count;
                expected_count = (old_count > 0) ? old_count - 1 : 0;
                expected_count = expected_count + $countones(i_pulse_in);
                expected_pulse = (old_count > 0);
                if (expected_count >= (1 << COUNT_WIDTH)) begin
                    failures = failures + 1;
                    $display("FAIL cycle=%0d reference overflow", cycle);
                end
            end
            #1;
            if (o_count_out !== expected_count[COUNT_WIDTH-1:0]) begin
                failures = failures + 1;
                $display("FAIL cycle=%0d count expected=%0d actual=%0d", cycle, expected_count, o_count_out);
            end
            if (o_pulse_out !== expected_pulse) begin
                failures = failures + 1;
                $display("FAIL cycle=%0d pulse expected=%b actual=%b", cycle, expected_pulse, o_pulse_out);
            end
        end
    endtask

    initial begin
        failures = 0;
        cycle = 0;
        seed = SEED;
        old_count = 0;
        expected_count = 0;
        expected_pulse = 1'b0;
        repeat (3) begin
            @(negedge i_clk);
            i_rst = 1'b1;
            i_pulse_in = '0;
            @(posedge i_clk);
            check();
            cycle = cycle + 1;
        end
        i_rst = 1'b0;
        for (cycle = 3; cycle < MAX_CYCLES; cycle = cycle + 1) begin
            @(negedge i_clk);
            i_rst = ((cycle % 211) == 0);
            if (i_rst) begin
                i_pulse_in = '0;
            end else begin
                choice = $urandom(seed) % 10;
                if (choice < 6) i_pulse_in = '0;
                else if (choice < 9) begin
                    bit_index = $urandom(seed) % INPUT_WIDTH;
                    i_pulse_in = ({{(INPUT_WIDTH-1){1'b0}},1'b1} << bit_index);
                end else i_pulse_in = {{(INPUT_WIDTH-2){1'b0}},2'b11};
            end
            @(posedge i_clk);
            check();
        end
        i_rst = 1'b0;
        i_pulse_in = '0;
        repeat (COUNT_WIDTH + 4) begin
            @(posedge i_clk);
            check();
            cycle = cycle + 1;
        end
        if (expected_count != 0) begin
            failures = failures + 1;
            $display("FAIL final count did not drain: %0d", expected_count);
        end
        if (failures != 0) $fatal(1, "pulse_merge failures=%0d", failures);
        $display("PASS pulse_merge INPUT_WIDTH=%0d COUNT_WIDTH=%0d SEED=%0d", INPUT_WIDTH, COUNT_WIDTH, SEED);
        $finish;
    end
endmodule

`default_nettype wire

