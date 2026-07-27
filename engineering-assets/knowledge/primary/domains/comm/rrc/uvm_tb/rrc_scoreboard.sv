// ============================================================================
// RRC Scoreboard — 黄金向量比对 (Q2.14, tol=±1 LSB)
// 读取 expected_tx.bin, 逐样点比对 RRC 插值输出
// ============================================================================

class rrc_scoreboard extends generic_scoreboard;

    `uvm_component_utils(rrc_scoreboard)

    function new(string name, uvm_component parent);
        super.new(name, parent);
        golden_fname = "expected_tx.bin";
    endfunction

    // ---- Q2.14 容差比对: 定点量化允许 ±1 LSB ----
    virtual function bit compare_item(axi_stream_seq_item item, int expected);
        logic [15:0] got_i, got_q, exp_i, exp_q;
        int diff_i, diff_q;

        got_i = item.data[15:0];
        got_q = item.data[31:16];
        exp_i = expected[15:0];
        exp_q = expected[31:16];

        diff_i = $signed(got_i) - $signed(exp_i);
        diff_q = $signed(got_q) - $signed(exp_q);

        // 容差 ±1 LSB (舍入误差)
        if ((diff_i > 1) || (diff_i < -1) || (diff_q > 1) || (diff_q < -1)) begin
            if (error_count <= max_errors)
                `uvm_info(get_type_name(),
                    $sformatf("Mismatch[%0d]: got={%04x,%04x} exp={%04x,%04x} diff={%0d,%0d}",
                        golden_idx, got_q, got_i, exp_q, exp_i, diff_q, diff_i), UVM_MEDIUM)
            return 0;
        end
        return 1;
    endfunction

endclass