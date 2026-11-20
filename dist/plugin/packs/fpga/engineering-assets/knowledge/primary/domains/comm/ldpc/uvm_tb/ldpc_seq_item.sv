// ============================================================================
// LDPC Sequence Item — LLR 输入 + decoded 输出
// 输入: signed 10-bit LLR (P_Q_DATA_W=10), 输出: 1-bit decoded
// ============================================================================

class ldpc_seq_item extends uvm_sequence_item;

    // ---- 输入: LLR 数据 (signed, 10-bit) ----
    rand logic signed [9:0]   llr_data;       // LLR 软比特
    rand logic                last;           // 码块结束

    // ---- 输出: 解码结果 ----
    logic                      decoded_bit;   // 1-bit 硬判决

    // ---- 元数据 ----
    int                        block_id;      // 码块序号
    int                        bit_idx;       // 码块内 bit 位置
    time                       timestamp;     // 仿真时间

    // ---- 覆盖率: 输入 LLR 分布 ----
    covergroup llr_cg @(llr_data);
        LLR_RANGE: coverpoint llr_data {
            bins neg_large  = {[-512:-201]};
            bins neg_med    = {[-200:-51]};
            bins neg_small  = {[-50:-1]};
            bins zero       = {0};
            bins pos_small  = {[1:50]};
            bins pos_med    = {[51:200]};
            bins pos_large  = {[201:511]};
        }
    endgroup

    function new(string name = "ldpc_seq_item");
        super.new(name);
        llr_cg = new();
    endfunction

    // ---- 约束: LLR 在有效范围内 ----
    constraint c_llr_range {
        llr_data inside {[-512:511]};
    }

    // ---- Utility macros ----
    `uvm_object_utils_begin(ldpc_seq_item)
        `uvm_field_int(llr_data,       UVM_DEFAULT)
        `uvm_field_int(last,           UVM_DEFAULT)
        `uvm_field_int(decoded_bit,    UVM_DEFAULT)
        `uvm_field_int(block_id,       UVM_DEFAULT)
        `uvm_field_int(bit_idx,        UVM_DEFAULT)
    `uvm_object_utils_end

endclass : ldpc_seq_item
