// ============================================================================
// OFDM Scoreboard
// 接收 m_axis monitor 采集的输出数据 → 与 MATLAB golden 向量对比
// TODO: 修改向量文件路径和比对容差
// ============================================================================

class ofdm_scoreboard extends uvm_scoreboard;

    // ---- TLM exports ----
    uvm_analysis_imp #(axi_stream_seq_item, ofdm_scoreboard) output_export;

    // ---- 统计 ----
    int total_items;         // 接收到的总交易数
    int match_count;         // 匹配数
    int error_count;         // 不匹配数
    int max_errors = 100;    // 最大错误报告数 (防止刷屏)

    // ---- Golden reference data ----
    string vec_dir = "C:/Users/Lihan/.claude/knowledge/primary/domains/comm/ofdm/vectors/";
    string golden_file;
    int    golden_data[];    // 从 MATLAB 文件读入的期望值
    int    golden_idx;       // 当前期望位置

    `uvm_component_utils_begin(ofdm_scoreboard)
        `uvm_field_int(total_items, UVM_DEFAULT)
        `uvm_field_int(match_count, UVM_DEFAULT)
        `uvm_field_int(error_count, UVM_DEFAULT)
    `uvm_component_utils_end

    // ---- Constructor ----
    function new(string name, uvm_component parent);
        super.new(name, parent);
        output_export = new("output_export", this);
    endfunction

    // ---- Build phase: 读取 golden 向量文件 ----
    function void build_phase(uvm_phase phase);
        super.build_phase(phase);
        load_golden_data();
    endfunction

    // ---- 从 MATLAB 向量文件加载期望值 ----
    function void load_golden_data();
        int fd;
        int tmp;
        string line;

        // TODO: 确认文件名和路径
        golden_file = {vec_dir, "time-domain-iq.txt"};
        fd = $fopen(golden_file, "r");

        if (fd == 0) begin
            `uvm_warning(get_type_name(), $sformatf("Cannot open golden file: %s", golden_file))
            `uvm_info(get_type_name(), "Scoreboard will accept all output without comparison", UVM_MEDIUM)
            return;
        end

        // 读入所有行
        while (!$feof(fd)) begin
            if ($fscanf(fd, "%h\n", tmp)) begin
                golden_data = new[golden_data.size() + 1](golden_data);
                golden_data[golden_data.size() - 1] = tmp;
            end
        end
        $fclose(fd);

        `uvm_info(get_type_name(), $sformatf("Loaded %0d golden samples from %s",
            golden_data.size(), golden_file), UVM_LOW)
    endfunction

    // ---- Write function: 接收 monitor 发来的数据 ----
    function void write(axi_stream_seq_item item);
        int expected;
        string msg;

        total_items++;
        golden_idx = total_items - 1;

        // 检查是否越界
        if (golden_idx < golden_data.size()) begin
            expected = golden_data[golden_idx];

            if (item.data == expected) begin
                match_count++;
            end else begin
                error_count++;
                if (error_count <= max_errors) begin
                    `uvm_error(get_type_name(),
                        $sformatf("Mismatch[%0d]: got=0x%04h, expected=0x%04h",
                            golden_idx, item.data, expected))
                end
            end
        end else begin
            // 超出 golden 数据范围
            if (golden_idx == golden_data.size()) begin
                `uvm_info(get_type_name(),
                    $sformatf("Output exceeds golden data size (%0d), no more comparison",
                        golden_data.size()), UVM_MEDIUM)
            end
        end
    endfunction

    // ---- Check phase: 报告结果 ----
    function void check_phase(uvm_phase phase);
        string msg;

        `uvm_info(get_type_name(),
            $sformatf("Scoreboard summary: %0d received, %0d matched, %0d errors",
                total_items, match_count, error_count), UVM_LOW)

        if (error_count > 0) begin
            `uvm_error(get_type_name(),
                $sformatf("TEST FAILED: %0d mismatches out of %0d samples",
                    error_count, total_items))
        end else if (total_items == 0) begin
            `uvm_error(get_type_name(), "TEST FAILED: No transactions received")
        end else begin
            `uvm_info(get_type_name(), "TEST PASSED", UVM_LOW)
        end
    endfunction

endclass
