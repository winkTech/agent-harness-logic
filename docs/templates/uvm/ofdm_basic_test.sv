// ============================================================================
// OFDM Basic Test (定向序列)
//   - 创建 ofdm_basic_seq 序列
//   - 配置参数 (num_items / mod_type)
//   - 在 env.agent.sqr 上启动序列
// ============================================================================

class ofdm_basic_test extends ofdm_base_test;

    `uvm_component_utils(ofdm_basic_test)

    // ---- Constructor ----
    function new(string name, uvm_component parent);
        super.new(name, parent);
    endfunction

    // ---- Run phase: 启动序列 ----
    task run_phase(uvm_phase phase);
        ofdm_basic_seq seq;
        int symbol_cnt;

        phase.raise_objection(this);

        `uvm_info(get_type_name(), $sformatf(
            "Starting test: FFT=%0d, CP=%0d, MOD=%0d, SYM=%0d",
            fft_len, cp_len, mod_type, num_sym), UVM_LOW)

        // 创建并配置序列
        seq = ofdm_basic_seq::type_id::create("seq");
        seq.num_items = fft_len * num_sym;
        seq.mod_type  = mod_type;

        // 在 agent 的 sequencer 上启动
        seq.start(env.agent.sqr);

        `uvm_info(get_type_name(), $sformatf(
            "Sequence done, waiting %0d cycles for DUT pipeline...",
            num_sym * (fft_len + cp_len)), UVM_LOW)

        // 等待 DUT 流水线处理完成
        // 给足够的裕量: num_sym * (FFT+CP) * 2
        #(num_sym * (fft_len + cp_len) * 10 * 2);

        phase.drop_objection(this);
    endtask

endclass
