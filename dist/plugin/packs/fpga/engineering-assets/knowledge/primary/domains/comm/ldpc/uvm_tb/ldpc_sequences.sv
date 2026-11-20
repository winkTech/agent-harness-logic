// ============================================================================
// LDPC Decoder Sequences
// 生成 LLR 测试序列 (由 MATLAB gen_rtl_test_vectors.m 预生成)
// ============================================================================

class ldpc_base_seq extends uvm_sequence #(uvm_sequence_item);
    `uvm_object_utils(ldpc_base_seq)

    int test_id = 0;

    function new(string name = "ldpc_base_seq");
        super.new(name);
    endfunction : new
endclass : ldpc_base_seq


// basic_test_seq: 从 .hex 文件加载 LLR 值并驱动到 DUT
class ldpc_basic_test_seq extends ldpc_base_seq;
    `uvm_object_utils(ldpc_basic_test_seq)

    // 导入 LDPC 参数 (应与 RTL 一致)
    localparam P_N = 648;   // 码长
    localparam P_K = 324;   // 信息位长

    function new(string name = "ldpc_basic_test_seq");
        super.new(name);
    endfunction : new

    virtual task body();
        `uvm_info(get_type_name(), $sformatf("Starting LDPC test #%0d", test_id), UVM_MEDIUM)
        // 序列体 — 由 basic_test 通过 config_db 获取向量路径并驱动
        // 实际驱动在 driver 中实现, sequence 提供配置和同步
        `uvm_info(get_type_name(), "Sequence complete", UVM_MEDIUM)
    endtask : body

endclass : ldpc_basic_test_seq
