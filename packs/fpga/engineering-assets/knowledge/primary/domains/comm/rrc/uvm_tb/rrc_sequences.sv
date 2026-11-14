// ============================================================================
// RRC 测试序列
// 生成 {Q,I} 32-bit 符号驱动 RRC 滤波器
// ============================================================================

// ---- 基础定向序列: QPSK ----
class rrc_qpsk_seq extends uvm_sequence #(axi_stream_seq_item);

    int num_symbols = 32;

    `uvm_object_utils(rrc_qpsk_seq)

    function new(string name = "rrc_qpsk_seq");
        super.new(name);
    endfunction

    virtual task body();
        logic signed [15:0] q_val, i_val;
        `uvm_info(get_type_name(), $sformatf("Starting QPSK seq: %0d symbols", num_symbols), UVM_LOW)

        for (int i = 0; i < num_symbols; i++) begin
            `uvm_create(req)
            // QPSK: normalized to Q2.14 (±1.0 = ±16384)
            case (i % 4)
                0: begin i_val =  16384; q_val =  16384; end  // 1+j1
                1: begin i_val =  16384; q_val = -16384; end  // 1-j1
                2: begin i_val = -16384; q_val =  16384; end  // -1+j1
                3: begin i_val = -16384; q_val = -16384; end  // -1-j1
            endcase
            req.data = {q_val, i_val};  // 32-bit {Q[15:0], I[15:0]}
            req.last = (i == num_symbols - 1);
            `uvm_send(req)
            // RRC 4x插值: 每个符号后留空让 filter 输出 4 个样点
            // 序列自动处理背靠背; driver 按 tready 节拍驱动
        end

        `uvm_info(get_type_name(), $sformatf("Sent %0d QPSK symbols", num_symbols), UVM_LOW)
    endtask

endclass


// ---- 16QAM 序列 ----
class rrc_16qam_seq extends uvm_sequence #(axi_stream_seq_item);

    int num_symbols = 32;

    `uvm_object_utils(rrc_16qam_seq)

    function new(string name = "rrc_16qam_seq");
        super.new(name);
    endfunction

    virtual task body();
        logic signed [15:0] i_val, q_val;
        int quant = 16384;  // Q2.14 scale

        `uvm_info(get_type_name(), $sformatf("Starting 16QAM seq: %0d symbols", num_symbols), UVM_LOW)

        for (int i = 0; i < num_symbols; i++) begin
            `uvm_create(req)
            // 16QAM normalized: {±1, ±3}/sqrt(10) → Q2.14
            case (i % 16)
                 0: begin i_val =  5180; q_val =  5180; end  //  1+ j1
                 1: begin i_val =  5180; q_val =  15540; end //  1+ j3
                 2: begin i_val =  15540; q_val =  5180; end //  3+ j1
                 3: begin i_val =  15540; q_val =  15540; end//  3+ j3
                 4: begin i_val =  5180; q_val = -5180; end
                 5: begin i_val =  5180; q_val = -15540; end
                 6: begin i_val =  15540; q_val = -5180; end
                 7: begin i_val =  15540; q_val = -15540; end
                 8: begin i_val = -5180; q_val =  5180; end
                 9: begin i_val = -5180; q_val =  15540; end
                10: begin i_val = -15540; q_val =  5180; end
                11: begin i_val = -15540; q_val =  15540; end
                12: begin i_val = -5180; q_val = -5180; end
                13: begin i_val = -5180; q_val = -15540; end
                14: begin i_val = -15540; q_val = -5180; end
                15: begin i_val = -15540; q_val = -15540; end
            endcase
            req.data = {q_val, i_val};
            req.last = (i == num_symbols - 1);
            `uvm_send(req)
        end
        `uvm_info(get_type_name(), $sformatf("Sent %0d 16QAM symbols", num_symbols), UVM_LOW)
    endtask

endclass