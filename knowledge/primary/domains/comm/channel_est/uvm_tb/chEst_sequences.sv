// ============================================================================
// Channel Estimation 测试序列
// 生成 OFDM 频域符号 (含导频) 驱动 LS 估计器
// ============================================================================

class chEst_basic_seq extends uvm_sequence #(axi_stream_seq_item);

    int num_subcarriers = 64;  // 每个 OFDM 符号的子载波数
    int num_symbols     = 1;   // OFDM 符号数

    `uvm_object_utils(chEst_basic_seq)

    function new(string name = "chEst_basic_seq");
        super.new(name);
    endfunction

    virtual task body();
        `uvm_info(get_type_name(), $sformatf(
            "Starting ChEst seq: %0d syms, %0d carriers", num_symbols, num_subcarriers), UVM_LOW)

        for (int sym = 0; sym < num_symbols; sym++) begin
            for (int sc = 0; sc < num_subcarriers; sc++) begin
                `uvm_create(req)
                // 模拟 OFDM 频域符号: 已知导频 (BPSK ±1 in Q2.14)
                // 子载波 -21,-7,7,21 为导频, 其余为数据
                if (sc == 11 || sc == 25 || sc == 39 || sc == 53) begin
                    // 导频: BPSK = ±1 (Q2.14: 16384)
                    req.data = (sc % 2 == 0) ? 32'h40004000 : 32'hC000C000;
                end else begin
                    // 数据: QPSK 随机
                    req.data = 32'h20001000;
                end
                req.last = (sym == num_symbols - 1) && (sc == num_subcarriers - 1);
                `uvm_send(req)
            end
        end

        `uvm_info(get_type_name(), "ChEst sequence done", UVM_LOW)
    endtask

endclass