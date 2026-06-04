// ============================================================================
// OFDM Base Test
// 所有 ofdm testcase 的基类:
//   - 创建 env
//   - 设置虚接口 (从顶层通过 config_db 传入)
//   - 提供 run_phase 钩子供子类重写
// ============================================================================

class ofdm_base_test extends uvm_test;

    // ---- Environment ----
    ofdm_env env;

    // ---- Test parameters (可被子类 override) ----
    // TODO: 参数化, 可通过 uvm_config_db 或命令行设置
    // 例: +uvm_set_int=ofdm_base_test,fft_len,1,128
    int fft_len   = 64;
    int cp_len    = 16;
    int mod_type  = 1;     // 0:BPSK, 1:QPSK, 2:16QAM, 3:64QAM
    int num_sym   = 10;    // OFDM 符号数

    `uvm_component_utils_begin(ofdm_base_test)
        `uvm_field_int(fft_len,  UVM_DEFAULT)
        `uvm_field_int(cp_len,   UVM_DEFAULT)
        `uvm_field_int(mod_type, UVM_DEFAULT)
        `uvm_field_int(num_sym,  UVM_DEFAULT)
    `uvm_component_utils_end

    // ---- Constructor ----
    function new(string name, uvm_component parent);
        super.new(name, parent);
    endfunction

    // ---- Build phase ----
    function void build_phase(uvm_phase phase);
        super.build_phase(phase);

        // 设置虚接口 (来自顶层)
        uvm_config_db #(virtual axi_stream_if #(16))::set(this,
            "env.agent.drv",    "vif", get_input_vif());
        uvm_config_db #(virtual axi_stream_if #(16))::set(this,
            "env.agent.in_mon", "vif", get_input_vif());
        uvm_config_db #(virtual axi_stream_if #(32))::set(this,
            "env.agent.out_mon", "vif", get_output_vif());

        env = ofdm_env::type_id::create("env", this);
    endfunction

    // ---- 获取虚接口 (由顶层在 run_test 前设置) ----
    function virtual axi_stream_if #(16) get_input_vif();
        virtual axi_stream_if #(16) vif;
        if (!uvm_config_db #(virtual axi_stream_if #(16))::get(this, "", "s_axis_vif", vif))
            `uvm_fatal("NOVIF", "s_axis_vif not set in config_db")
        return vif;
    endfunction

    function virtual axi_stream_if #(32) get_output_vif();
        virtual axi_stream_if #(32) vif;
        if (!uvm_config_db #(virtual axi_stream_if #(32))::get(this, "", "m_axis_vif", vif))
            `uvm_fatal("NOVIF", "m_axis_vif not set in config_db")
        return vif;
    endfunction

    // ---- 复位控制 ----
    task assert_reset(int cycles = 20);
        virtual reset_if vif;
        if (!uvm_config_db #(virtual reset_if)::get(this, "", "reset_vif", vif))
            `uvm_fatal("NORST", "reset_vif not set in config_db")
        @(posedge vif.clk);
        force vif.rst_n = 1'b0;
        repeat(cycles) @(posedge vif.clk);
        force vif.rst_n = 1'b1;
        repeat(5) @(posedge vif.clk);
        `uvm_info(get_type_name(), $sformatf("Reset completed (%0d cycles)", cycles), UVM_MEDIUM)
    endtask

    // ---- End of elaboration ----
    function void end_of_elaboration_phase(uvm_phase phase);
        uvm_top.print_topology();
    endfunction

    // ---- Report phase ----
    function void report_phase(uvm_phase phase);
        uvm_report_server svr = uvm_report_server::get_server();
        if (svr.get_severity_count(UVM_FATAL) +
            svr.get_severity_count(UVM_ERROR) == 0)
            `uvm_info(get_type_name(), "*** TEST PASSED ***", UVM_LOW)
        else
            `uvm_info(get_type_name(), "*** TEST FAILED ***", UVM_LOW)
    endfunction

endclass
