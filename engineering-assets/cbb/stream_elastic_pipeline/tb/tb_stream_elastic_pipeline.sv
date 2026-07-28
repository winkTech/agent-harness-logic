`timescale 1ns/1ps
`default_nettype none

module tb_stream_elastic_pipeline #(
    parameter integer DATA_WIDTH = 12,
    parameter integer DEPTH = 4,
    parameter integer MAX_CYCLES = 1200,
    parameter integer SEED = 32'h005EED01
);
    reg i_clk = 1'b0;
    reg i_rst = 1'b1;
    reg [DATA_WIDTH-1:0] i_tdata = {DATA_WIDTH{1'b0}};
    reg i_tvalid = 1'b0;
    wire o_tready;
    wire [DATA_WIDTH-1:0] o_tdata;
    wire o_tvalid;
    reg i_tready = 1'b0;

    integer cycle;
    integer seed;
    integer failures;
    integer q_head;
    integer q_tail;
    integer q_count;
    reg [DATA_WIDTH-1:0] expected [0:DEPTH+MAX_CYCLES];
    reg stalled_prev;
    reg [DATA_WIDTH-1:0] stalled_data_prev;

    always #5 i_clk = ~i_clk;

    stream_elastic_pipeline #(
        .DATA_WIDTH(DATA_WIDTH),
        .DEPTH(DEPTH)
    ) dut (
        .i_clk(i_clk), .i_rst(i_rst), .i_tdata(i_tdata), .i_tvalid(i_tvalid),
        .o_tready(o_tready), .o_tdata(o_tdata), .o_tvalid(o_tvalid), .i_tready(i_tready)
    );

`ifdef STREAM_ELASTIC_PIPELINE_SVA
    stream_elastic_pipeline_sva #(
        .DATA_WIDTH(DATA_WIDTH)
    ) assertions (
        .i_clk(i_clk), .i_rst(i_rst), .i_tdata(i_tdata), .i_tvalid(i_tvalid),
        .o_tready(o_tready), .o_tdata(o_tdata), .o_tvalid(o_tvalid), .i_tready(i_tready)
    );
`endif

    task automatic fail;
        input [1023:0] message;
        begin
            failures = failures + 1;
            $display("FAIL cycle=%0d %0s", cycle, message);
        end
    endtask

    task automatic sample_pre_edge;
        reg [DATA_WIDTH-1:0] expected_head;
        begin
            #1;
            if (stalled_prev && (!o_tvalid || o_tdata !== stalled_data_prev))
                fail("output changed while stalled");

            if (!i_rst) begin
                if (o_tvalid && i_tready) begin
                    if (q_count == 0) begin
                        fail("DUT emitted without a reference transaction");
                    end else begin
                        expected_head = expected[q_head];
                        if (o_tdata !== expected_head)
                            fail("output order/data mismatch");
                        q_head = q_head + 1;
                        q_count = q_count - 1;
                    end
                end
                if (i_tvalid && o_tready) begin
                    expected[q_tail] = i_tdata;
                    q_tail = q_tail + 1;
                    q_count = q_count + 1;
                    if (q_count > DEPTH) fail("reference queue overflow");
                end
            end
            stalled_prev = o_tvalid && !i_tready && !i_rst;
            stalled_data_prev = o_tdata;
        end
    endtask

    task automatic check_post_edge;
        begin
            if (i_rst) begin
                if (o_tvalid) fail("output valid after reset edge");
                q_head = 0;
                q_tail = 0;
                q_count = 0;
            end else begin
                if (o_tvalid && q_count == 0)
                    fail("DUT emitted without a reference transaction");
                if (o_tvalid && q_count != 0 && o_tdata !== expected[q_head])
                    fail("head data does not match reference queue");
            end
        end
    endtask

    initial begin
        failures = 0;
        cycle = 0;
        seed = SEED;
        q_head = 0;
        q_tail = 0;
        q_count = 0;
        stalled_prev = 1'b0;
        stalled_data_prev = '0;

        repeat (3) begin
            @(negedge i_clk);
            i_rst = 1'b1;
            i_tvalid = 1'b0;
            i_tready = 1'b1;
            sample_pre_edge();
            @(posedge i_clk);
            #1;
            check_post_edge();
            cycle = cycle + 1;
        end

        i_rst = 1'b0;
        for (cycle = 3; cycle < MAX_CYCLES; cycle = cycle + 1) begin
            @(negedge i_clk);
            i_rst = (cycle != 0 && (cycle % 173) == 0);
            i_tvalid = i_rst ? 1'b0 : ($urandom(seed) & 1);
            i_tdata = $urandom(seed);
            i_tready = $urandom(seed) & 1;
            sample_pre_edge();
            @(posedge i_clk);
            #1;
            check_post_edge();
        end

        i_rst = 1'b0;
        i_tvalid = 1'b0;
        i_tready = 1'b1;
        repeat (DEPTH + 4) begin
            @(negedge i_clk);
            sample_pre_edge();
            @(posedge i_clk);
            #1;
            check_post_edge();
        end
        if (q_count != 0) fail("reference queue did not drain");
        if (failures != 0) $fatal(1, "stream_elastic_pipeline failures=%0d", failures);
        $display("PASS stream_elastic_pipeline DATA_WIDTH=%0d DEPTH=%0d SEED=%0d", DATA_WIDTH, DEPTH, SEED);
        $finish;
    end
endmodule

`default_nettype wire
