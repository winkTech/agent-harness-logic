//==============================================================================
// RRC Pulse Shaping Filter - Self-Checking Testbench
// Reads MATLAB golden vectors, auto-compares output
//==============================================================================
`timescale 1ns / 1ps

module tb_rrc_top;

    localparam CLK_PERIOD = 10;
    localparam DATA_W     = 16;
    localparam SYM_PERIOD = 100;

    logic                clk;
    logic                rst_n;
    logic                s_axis_tvalid;
    logic                s_axis_tready;
    logic [31:0]         s_axis_tdata;
    logic                m_axis_tvalid;
    logic                m_axis_tready;
    logic [31:0]         m_axis_tdata;

    int                  sim_cycles;
    int                  err_count;
    int                  sym_count;
    int                  sample_count;
    int                  max_symbols = 256;

    rrc_top #(.DATA_W(DATA_W)) u_dut (.*, .alpha_sel(8'h02));

    initial clk = 1'b0;
    always #(CLK_PERIOD/2) clk = ~clk;

    initial begin
        logic signed [15:0] stim_i [];
        logic signed [15:0] stim_q [];
        logic signed [15:0] gold_i [];
        logic signed [15:0] gold_q [];
        int fd_in, fd_gold, gold_count;
        int hex_val_i, hex_val_q;

        err_count = 0; sym_count = 0;
        sample_count = 0; sim_cycles = 0;

        rst_n = 1'b0;
        s_axis_tvalid = 1'b0;
        s_axis_tdata = '0;
        m_axis_tready = 1'b1;

        repeat (10) @(posedge clk);
        rst_n = 1'b1;
        repeat (5) @(posedge clk);

        stim_i = new [max_symbols];
        stim_q = new [max_symbols];

        fd_in = $fopen("rrc_test_qpsk_alpha0.50_sps4_input.hex", "r");
        if (fd_in == 0) begin
            $display("[ERROR] Cannot open stimulus file");
            $finish;
        end

        for (int i = 0; i < max_symbols; i++) begin
            if ($fscanf(fd_in, "%04h%04h
", hex_val_i, hex_val_q) != 2) begin
                max_symbols = i;
                break;
            end
            stim_i[i] = 16'(hex_val_i);
            stim_q[i] = 16'(hex_val_q);
        end
        $fclose(fd_in);
        $display("[INFO] Loaded %0d stimulus symbols", max_symbols);

        gold_i = new [max_symbols * 4];
        gold_q = new [max_symbols * 4];
        gold_count = 0;

        fd_gold = $fopen("rrc_test_qpsk_alpha0.50_sps4_output_quant.hex", "r");
        if (fd_gold == 0) begin
            $display("[WARN] No golden file - skip compare");
        end else begin
            for (int i = 0; i < max_symbols * 4; i++) begin
                if ($fscanf(fd_gold, "%04h%04h
", hex_val_i, hex_val_q) != 2) break;
                gold_i[i] = 16'(hex_val_i);
                gold_q[i] = 16'(hex_val_q);
                gold_count++;
            end
            $fclose(fd_gold);
            $display("[INFO] Loaded %0d golden samples", gold_count);
        end

        for (int s = 0; s < max_symbols; s++) begin
            s_axis_tvalid <= 1'b1;
            s_axis_tdata <= {stim_q[s], stim_i[s]};
            sym_count++;
            @(posedge clk);
            wait (s_axis_tready);
            repeat (4) begin
                @(posedge clk);
                if (m_axis_tvalid && m_axis_tready) begin
                    sample_count++;
                    if (sample_count <= gold_count) begin
                        if (m_axis_tdata[15:0] != gold_i[sample_count-1] ||
                            m_axis_tdata[31:16] != gold_q[sample_count-1]) begin
                            $display("[FAIL] Sample %0d: I=%04h/%04h Q=%04h/%04h",
                                sample_count,
                                m_axis_tdata[15:0], gold_i[sample_count-1],
                                m_axis_tdata[31:16], gold_q[sample_count-1]);
                            err_count++;
                        end
                    end
                end
            end
            s_axis_tvalid <= 1'b0;
            repeat (SYM_PERIOD - 5) @(posedge clk);
        end

        repeat (8) begin
            @(posedge clk);
            if (m_axis_tvalid && m_axis_tready) begin
                sample_count++;
                if (sample_count <= gold_count) begin
                    if (m_axis_tdata[15:0] != gold_i[sample_count-1] ||
                        m_axis_tdata[31:16] != gold_q[sample_count-1]) begin
                        $display("[FAIL] Flush sample %0d", sample_count);
                        err_count++;
                    end
                end
            end
        end

        $display("========================================");
        $display("  RRC Testbench Complete");
        $display("  Symbols: %0d", sym_count);
        $display("  Samples: %0d", sample_count);
        if (err_count == 0)
            $display("  RESULT: PASS");
        else
            $display("  RESULT: FAIL (%0d errors)", err_count);
        $display("========================================");
        $finish;
    end

    initial begin
        repeat (100000) @(posedge clk);
        $display("[TIMEOUT]");
        $finish;
    end

    always @(posedge clk) sim_cycles++;

endmodule : tb_rrc_top
