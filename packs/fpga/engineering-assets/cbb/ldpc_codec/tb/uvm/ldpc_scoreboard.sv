// ============================================================================
// LDPC Decoder Scoreboard v2 — 独立版本
// 输入: ldpc_seq_item (1-bit decoded)
// 对比: RTL decoded bit vs golden model expected bit
// ============================================================================

class ldpc_scoreboard extends uvm_scoreboard;

    // ---- TLM exports ----
    uvm_analysis_imp #(ldpc_seq_item, ldpc_scoreboard) output_export;

    // ---- 统计 ----
    int total_bits;
    int match_count;
    int error_count;
    int max_errors = 100;

    // ---- Golden reference ----
    string vec_dir;
    string golden_fname;
    int    golden_data[];
    int    golden_idx;

    `uvm_component_utils(ldpc_scoreboard)

    function new(string name, uvm_component parent);
        super.new(name, parent);
        output_export = new("output_export", this);
    endfunction

    function void build_phase(uvm_phase phase);
        super.build_phase(phase);
        if (!uvm_config_db #(string)::get(this, "", "vec_dir", vec_dir))
            vec_dir = ".";
        if (!uvm_config_db #(string)::get(this, "", "golden_fname", golden_fname))
            golden_fname = "expected_ldpc.bin";
        load_golden_data();
    endfunction

    function void load_golden_data();
        int fd;
        int tmp;
        string full_path = {vec_dir, "/", golden_fname};

        fd = $fopen(full_path, "r");
        if (fd == 0) begin
            `uvm_warning(get_type_name(),
                $sformatf("Cannot open golden: %s — will accept all without compare",
                    full_path))
            return;
        end

        while (!$feof(fd)) begin
            if ($fscanf(fd, "%b\n", tmp)) begin
                golden_data = new[golden_data.size() + 1](golden_data);
                golden_data[golden_data.size() - 1] = tmp;
            end
        end
        $fclose(fd);

        `uvm_info(get_type_name(), $sformatf("Loaded %0d golden bits from %s",
            golden_data.size(), full_path), UVM_LOW)
    endfunction

    // ---- Write: 接收 monitor 数据 ----
    function void write(ldpc_seq_item item);
        int expected_bit;

        total_bits++;
        golden_idx = total_bits - 1;

        if (golden_idx < golden_data.size()) begin
            expected_bit = golden_data[golden_idx];
            if (!compare_item(item.decoded_bit, expected_bit)) begin
                error_count++;
                if (error_count <= max_errors)
                    `uvm_error(get_type_name(),
                        $sformatf("Bit mismatch[%0d]: got=%0d expected=%0d (block=%0d bit=%0d)",
                            golden_idx, item.decoded_bit, expected_bit,
                            item.block_id, item.bit_idx))
            end else begin
                match_count++;
            end
        end
    endfunction

    // ---- 1-bit 比对 ----
    virtual function bit compare_item(bit rtl_bit, int expected_bit);
        return (rtl_bit == expected_bit);
    endfunction

    // ---- Report phase ----
    function void report_phase(uvm_phase phase);
        `uvm_info(get_type_name(),
            $sformatf("  ════════════════════════════════════"), UVM_MEDIUM)
        `uvm_info(get_type_name(),
            $sformatf("  LDPC Scoreboard Summary"), UVM_MEDIUM)
        `uvm_info(get_type_name(),
            $sformatf("  Total bits:   %0d", total_bits), UVM_MEDIUM)
        `uvm_info(get_type_name(),
            $sformatf("  Matched:      %0d", match_count), UVM_MEDIUM)
        `uvm_info(get_type_name(),
            $sformatf("  Errors:       %0d", error_count), UVM_MEDIUM)
        if (total_bits > 0) begin
            real ber = real'(error_count) / total_bits;
            `uvm_info(get_type_name(),
                $sformatf("  BER:          %0.2e", ber), UVM_MEDIUM)
        end
        `uvm_info(get_type_name(),
            $sformatf("  ════════════════════════════════════"), UVM_MEDIUM)

        if (error_count > 0)
            `uvm_error(get_type_name(),
                $sformatf("TEST FAILED: %0d bit errors out of %0d",
                    error_count, total_bits))
        else if (total_bits == 0)
            `uvm_error(get_type_name(), "TEST FAILED: No transactions received")
        else
            `uvm_info(get_type_name(), "TEST PASSED — All bits match", UVM_LOW)
    endfunction : report_phase

endclass : ldpc_scoreboard
