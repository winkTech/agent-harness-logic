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

    // ---- 覆盖组: 数据范围分布 (统一覆盖率收集) ----
    covergroup data_range_cg;
        // I 路数据 (低 16-bit)
        DATA_I: coverpoint data[15:0] {
            bins zero     = {0};
            bins neg_small = {[1:1023]};
            bins neg_med   = {[1024:16383]};
            bins neg_large = {[16384:32767]};
            bins full_rng  = {[32768:65535]};
        }
        // Q 路数据 (高 16-bit)
        DATA_Q: coverpoint data[31:16] {
            bins zero     = {0};
            bins neg_small = {[1:1023]};
            bins neg_med   = {[1024:16383]};
            bins neg_large = {[16384:32767]};
            bins full_rng  = {[32768:65535]};
        }
        // 帧边界
        PKT_BOUNDARY: coverpoint last {
            bins not_last = {0};
            bins is_last  = {1};
        }
        // 交叉: 数据 × 帧边界
        DATA_X_BOUNDARY: cross DATA_I, PKT_BOUNDARY;
    endgroup

    // ---- Utility macros ----
    `uvm_object_utils_begin(axi_stream_seq_item)
        `uvm_field_int(data, UVM_DEFAULT)
        `uvm_field_int(last, UVM_DEFAULT)
    `uvm_object_utils_end

    // ---- Constructor ----
    function new(string name = "axi_stream_seq_item");
        super.new(name);
        data_range_cg = new();
    endfunction

endclass
