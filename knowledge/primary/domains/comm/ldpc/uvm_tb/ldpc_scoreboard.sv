// ============================================================================
// LDPC Decoder Scoreboard
// 对比: decoded bits (RTL) vs expected bits (golden model)
// ============================================================================

class ldpc_scoreboard extends generic_scoreboard #(.DATA_W(1));

    `uvm_component_utils(ldpc_scoreboard)

    // 统计
    int bit_errors;
    int ber_factor;  // = 1/ber_estimate

    function new(string name = "ldpc_scoreboard", uvm_component parent = null);
        super.new(name, parent);
        bit_errors = 0;
        ber_factor = 0;
    endfunction : new

    // compare_item: 逐 bit 比对
    virtual function bit compare_item(bit rtl_bit, bit exp_bit);
        if (rtl_bit !== exp_bit) begin
            bit_errors++;
            if (bit_errors <= 10) begin
                `uvm_error(get_type_name(),
                    $sformatf("  Bit mismatch: got=%0d exp=%0d (err#%0d/%0d)",
                              rtl_bit, exp_bit, bit_errors,
                              match_count + error_count))
            end
            return 0;  // mismatch
        end
        return 1;  // match
    endfunction : compare_item

    // report_phase: 输出 BER 统计
    virtual function void report_phase(uvm_phase phase);
        super.report_phase(phase);
        if (match_count + error_count > 0) begin
            real ber = real'(error_count) / (match_count + error_count);
            `uvm_info(get_type_name(),
                $sformatf("  ════════════════════════════════════"), UVM_MEDIUM)
            `uvm_info(get_type_name(),
                $sformatf("  LDPC Decoder Scoreboard Summary"), UVM_MEDIUM)
            `uvm_info(get_type_name(),
                $sformatf("  Total bits:   %0d", match_count + error_count), UVM_MEDIUM)
            `uvm_info(get_type_name(),
                $sformatf("  Matched:      %0d", match_count), UVM_MEDIUM)
            `uvm_info(get_type_name(),
                $sformatf("  Bit errors:   %0d", error_count), UVM_MEDIUM)
            `uvm_info(get_type_name(),
                $sformatf("  BER:          %0.2e", ber), UVM_MEDIUM)
            `uvm_info(get_type_name(),
                $sformatf("  ════════════════════════════════════"), UVM_MEDIUM)
        end
    endfunction : report_phase

endclass : ldpc_scoreboard
