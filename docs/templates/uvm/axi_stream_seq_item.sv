// ============================================================================
// AXI4-Stream Sequence Item
// 一笔 AXI4-Stream 交易 = data + tlast 信号
// TODO: 根据 DUT 需要扩展约束 (如数据范围/包长)
// ============================================================================

class axi_stream_seq_item extends uvm_sequence_item;

    // ---- 数据域 ----
    rand logic [31:0] data;      // 数据 (输入用低6bit, 输出32bit I+Q)
    rand logic        last;      // 帧结束标志

    // ---- 约束 ----
    constraint c_data_valid {
        // TODO: 修改 data 范围以匹配 DUT 位宽
        // 例如 6-bit: data inside {[0:63]};
        // 例如 32-bit: 移除约束或设大范围
    }

    // ---- Utility macros ----
    `uvm_object_utils_begin(axi_stream_seq_item)
        `uvm_field_int(data, UVM_DEFAULT)
        `uvm_field_int(last, UVM_DEFAULT)
    `uvm_object_utils_end

    // ---- Constructor ----
    function new(string name = "axi_stream_seq_item");
        super.new(name);
    endfunction

endclass
