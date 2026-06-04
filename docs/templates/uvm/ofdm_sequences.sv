// ============================================================================
// OFDM 测试序列
// 定向激励: 发送 N_SYM 个 OFDM 符号的调制比特
// TODO: 扩展为随机约束序列
// ============================================================================

// ---- 基础定向序列: QPSK 调制比特 ----
class ofdm_basic_seq extends uvm_sequence #(axi_stream_seq_item);

    int num_items = 640;    // 默认 64*10 = 640 个样本
    int mod_type  = 1;      // 0:BPSK, 1:QPSK, 2:16QAM, 3:64QAM

    `uvm_object_utils_begin(ofdm_basic_seq)
        `uvm_field_int(num_items, UVM_DEFAULT)
        `uvm_field_int(mod_type,  UVM_DEFAULT)
    `uvm_object_utils_end

    function new(string name = "ofdm_basic_seq");
        super.new(name);
    endfunction

    virtual task body();
        `uvm_info(get_type_name(), $sformatf(
            "Starting sequence: %0d items, MOD=%0d", num_items, mod_type), UVM_LOW)

        for (int i = 0; i < num_items; i++) begin
            `uvm_create(req)
            // 根据调制类型生成比特
            unique case (mod_type)
                0: req.data = (i % 2 == 0) ? 16'b1 : 16'b0;            // BPSK
                1: req.data = (i % 2 == 0) ? 16'b01 : 16'b10;          // QPSK
                2: req.data = (i % 4 == 0) ? 16'b0000 :                 // 16QAM
                              (i % 4 == 1) ? 16'b0001 :
                              (i % 4 == 2) ? 16'b0011 : 16'b0010;
                default: req.data = 16'b01;                              // 默认 QPSK
            endcase
            req.last = (i == num_items - 1);
            `uvm_send(req)
        end

        `uvm_info(get_type_name(), $sformatf(
            "Sent %0d items", num_items), UVM_LOW)
    endtask

endclass
