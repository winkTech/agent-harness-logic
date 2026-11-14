// ============================================================================
// OFDM Scoreboard — 继承通用基类, 匹配 32-bit {Q,I} 输出
// ============================================================================

class ofdm_scoreboard extends generic_scoreboard;

    `uvm_component_utils(ofdm_scoreboard)

    function new(string name, uvm_component parent);
        super.new(name, parent);
        golden_fname = "expected_tx.bin";
    endfunction

    virtual function bit compare_item(axi_stream_seq_item item, int expected);
        logic [15:0] got_i, got_q, exp_i, exp_q;
        int diff_i, diff_q;

        got_i = item.data[15:0];
        got_q = item.data[31:16];
        exp_i = expected[15:0];
        exp_q = expected[31:16];

        diff_i = $signed(got_i) - $signed(exp_i);
        diff_q = $signed(got_q) - $signed(exp_q);

        // Q3.13 容差 ±1 LSB
        if ((diff_i > 1) || (diff_i < -1) || (diff_q > 1) || (diff_q < -1)) begin
            if (error_count <= max_errors)
                `uvm_error(get_type_name(),
                    $sformatf("Mismatch[%0d]: got={%04x,%04x} exp={%04x,%04x} diff={%0d,%0d}",
                        golden_idx, got_q, got_i, exp_q, exp_i, diff_q, diff_i))
            return 0;
        end
        return 1;
    endfunction

endclass