// ============================================================================
// OFDM 附加测试用例
//   - ofdm_bpsk_test:   BPSK 调制 (MOD_TYPE=0)
//   - ofdm_16qam_test:  16QAM 调制 (MOD_TYPE=2)
//   - ofdm_reset_test:  运行中复位
// ============================================================================

// ====================================================================
// BPSK Test
// ====================================================================
class ofdm_bpsk_test extends ofdm_base_test;

    `uvm_component_utils(ofdm_bpsk_test)

    function new(string name, uvm_component parent);
        super.new(name, parent);
    endfunction

    task run_phase(uvm_phase phase);
        ofdm_basic_seq seq;

        phase.raise_objection(this);
        mod_type = 0;  // BPSK

        `uvm_info(get_type_name(), $sformatf(
            "BPSK test: FFT=%0d, CP=%0d, MOD=BPSK, SYM=%0d",
            fft_len, cp_len, num_sym), UVM_LOW)

        seq = ofdm_basic_seq::type_id::create("seq");
        seq.num_items = fft_len * num_sym;
        seq.mod_type  = 0;
        seq.start(env.agent.sqr);

        #(num_sym * (fft_len + cp_len) * 10 * 2);
        phase.drop_objection(this);
    endtask

endclass

// ====================================================================
// 16QAM Test
// ====================================================================
class ofdm_16qam_test extends ofdm_base_test;

    `uvm_component_utils(ofdm_16qam_test)

    function new(string name, uvm_component parent);
        super.new(name, parent);
    endfunction

    task run_phase(uvm_phase phase);
        ofdm_basic_seq seq;

        phase.raise_objection(this);
        mod_type = 2;  // 16QAM

        `uvm_info(get_type_name(), $sformatf(
            "16QAM test: FFT=%0d, CP=%0d, MOD=16QAM, SYM=%0d",
            fft_len, cp_len, num_sym), UVM_LOW)

        seq = ofdm_basic_seq::type_id::create("seq");
        seq.num_items = fft_len * num_sym;
        seq.mod_type  = 2;
        seq.start(env.agent.sqr);

        #(num_sym * (fft_len + cp_len) * 10 * 2);
        phase.drop_objection(this);
    endtask

endclass

// ====================================================================
// Reset Test: 发送部分数据后复位, 验证 DUT 行为
// ====================================================================
class ofdm_reset_test extends ofdm_base_test;

    `uvm_component_utils(ofdm_reset_test)

    function new(string name, uvm_component parent);
        super.new(name, parent);
    endfunction

    task run_phase(uvm_phase phase);
        ofdm_basic_seq seq;

        phase.raise_objection(this);
        mod_type = 1;  // QPSK

        `uvm_info(get_type_name(), "Reset test: send partial data, assert reset, verify behavior", UVM_LOW)

        // Phase 1: 发送前一半数据
        seq = ofdm_basic_seq::type_id::create("seq");
        seq.num_items = (fft_len * num_sym) / 2;
        seq.mod_type  = 1;
        seq.start(env.agent.sqr);

        `uvm_info(get_type_name(), "Phase 1 complete, asserting reset...", UVM_LOW)

        // Phase 2: 通过 reset_if 触发复位
        assert_reset(20);

        `uvm_info(get_type_name(), "Reset de-asserted, sending remaining data...", UVM_LOW)

        // Phase 3: 复位后继续发送
        seq = ofdm_basic_seq::type_id::create("seq");
        seq.num_items = (fft_len * num_sym) / 2;
        seq.mod_type  = 1;
        seq.start(env.agent.sqr);

        #(num_sym * (fft_len + cp_len) * 10 * 2);
        phase.drop_objection(this);
    endtask

endclass
