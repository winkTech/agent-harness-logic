// ============================================================================
// Synchronization Scoreboard
// 比对 pass-through 输出 + 控制信号校验占位
// TODO: 添加 packet_detected/sync_locked 时序验证
// ============================================================================

class sync_scoreboard extends generic_scoreboard;

    `uvm_component_utils(sync_scoreboard)

    function new(string name, uvm_component parent);
        super.new(name, parent);
        golden_fname = "expected_sync_out.bin";
    endfunction

    virtual function bit compare_item(axi_stream_seq_item item, int expected);
        // 同步模块当前为 pass-through, 期望逐样点精确匹配
        if (item.data != expected) begin
            if (error_count <= max_errors)
                `uvm_info(get_type_name(),
                    $sformatf("Mismatch[%0d]: got=0x%08h exp=0x%08h",
                        golden_idx, item.data, expected), UVM_MEDIUM)
            return 0;
        end
        return 1;
    endfunction

endclass