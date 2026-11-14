// ============================================================================
// 通用 Scoreboard — 黄金向量比对基类
// 功能:
//   读取 golden_expected.bin → 与 m_axis monitor 采集数据比对
//   子类通过 override golden_file + compare_item() 实现算法特定逻辑
// ============================================================================

class generic_scoreboard extends uvm_scoreboard;

    // ---- TLM exports ----
    uvm_analysis_imp #(axi_stream_seq_item, generic_scoreboard) output_export;

    // ---- 统计 ----
    int total_items;
    int match_count;
    int error_count;
    int max_errors = 100;

    // ---- Golden reference ----
    string vec_dir;          // 由顶层通过 config_db 设置
    string golden_fname;     // 由子类改: "expected_tx.bin" / "expected_chEst.bin" / ...
    int    golden_data[];
    int    golden_idx;

    `uvm_component_utils_begin(generic_scoreboard)
        `uvm_field_int(total_items, UVM_DEFAULT)
        `uvm_field_int(match_count, UVM_DEFAULT)
        `uvm_field_int(error_count, UVM_DEFAULT)
    `uvm_component_utils_end

    function new(string name, uvm_component parent);
        super.new(name, parent);
        output_export = new("output_export", this);
        golden_fname  = "expected_tx.bin";
    endfunction

    function void build_phase(uvm_phase phase);
        super.build_phase(phase);
        if (!uvm_config_db #(string)::get(this, "", "vec_dir", vec_dir))
            vec_dir = ".";
        if (!uvm_config_db #(string)::get(this, "", "golden_fname", golden_fname))
            ; // 使用默认值
        load_golden_data();
    endfunction

    function void load_golden_data();
        int fd;
        int tmp;
        string full_path = {vec_dir, "/", golden_fname};

        fd = $fopen(full_path, "r");
        if (fd == 0) begin
            `uvm_warning(get_type_name(),
                $sformatf("Cannot open golden: %s — will accept all output without compare",
                    full_path))
            return;
        end

        while (!$feof(fd)) begin
            if ($fscanf(fd, "%h\n", tmp)) begin
                golden_data = new[golden_data.size() + 1](golden_data);
                golden_data[golden_data.size() - 1] = tmp;
            end
        end
        $fclose(fd);

        `uvm_info(get_type_name(), $sformatf("Loaded %0d golden samples from %s",
            golden_data.size(), full_path), UVM_LOW)
    endfunction

    // ---- Write: 接收 monitor 数据 ----
    function void write(axi_stream_seq_item item);
        total_items++;
        golden_idx = total_items - 1;

        if (golden_idx < golden_data.size()) begin
            if (!compare_item(item, golden_data[golden_idx])) begin
                error_count++;
                if (error_count <= max_errors)
                    `uvm_error(get_type_name(),
                        $sformatf("Mismatch[%0d]: got=0x%08h expected=0x%08h",
                            golden_idx, item.data, golden_data[golden_idx]))
            end else begin
                match_count++;
            end
        end
    endfunction

    // ---- 可重载的比对函数 (子类改 tolerance / 解包方式) ----
    virtual function bit compare_item(axi_stream_seq_item item, int expected);
        return (item.data == expected);
    endfunction

    // ---- Check phase ----
    function void check_phase(uvm_phase phase);
        `uvm_info(get_type_name(),
            $sformatf("Scoreboard summary: %0d rcvd, %0d matched, %0d errors",
                total_items, match_count, error_count), UVM_LOW)

        if (error_count > 0)
            `uvm_error(get_type_name(),
                $sformatf("TEST FAILED: %0d mismatches out of %0d samples",
                    error_count, total_items))
        else if (total_items == 0)
            `uvm_error(get_type_name(), "TEST FAILED: No transactions received")
        else
            `uvm_info(get_type_name(), "TEST PASSED", UVM_LOW)
    endfunction

endclass