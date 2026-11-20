// ============================================================================
// Synchronization 测试序列
// 生成 preamble + 数据样本驱动包检测/定时/频偏估计
// ============================================================================

class sync_basic_seq extends uvm_sequence #(axi_stream_seq_item);

    int num_samples = 1024;

    `uvm_object_utils(sync_basic_seq)

    function new(string name = "sync_basic_seq");
        super.new(name);
    endfunction

    virtual task body();
        `uvm_info(get_type_name(), $sformatf(
            "Starting sync seq: %0d samples", num_samples), UVM_LOW)

        for (int i = 0; i < num_samples; i++) begin
            `uvm_create(req)
            // 前 320 个样本: STS (Short Training Sequence) 模拟
            // 其后: LTS + 数据
            if (i < 320) begin
                // STS: 16 点周期, BPSK ±1, Q2.14 缩放
                int sts_val[16] = '{  0,  11585,      0,  11585,
                                      0,  11585,      0,  11585,
                                      0,  11585,      0,  11585,
                                      0,  11585,      0,  11585};
                int idx = i % 16;
                req.data = {16'(sts_val[idx]), 16'(sts_val[idx])};
            end else begin
                // LTS + 数据: QPSK 调制
                req.data = (i % 2 == 0) ? 32'h40004000 : 32'hC000C000;
            end
            req.last = (i == num_samples - 1);
            `uvm_send(req)
        end

        `uvm_info(get_type_name(), "Sync sequence done", UVM_LOW)
    endtask

endclass