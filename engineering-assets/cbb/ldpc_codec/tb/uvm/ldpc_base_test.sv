// ============================================================================
// LDPC Decoder Base Test v2 — LDPC 专用环境
// 输入: 10-bit signed LLR AXI-Stream
// 输出: 1-bit decoded AXI-Stream
// ============================================================================

class ldpc_base_test extends uvm_test;

    ldpc_env    env;
    string      vec_dir = ".";

    `uvm_component_utils(ldpc_base_test)

    function new(string name = "ldpc_base_test", uvm_component parent = null);
        super.new(name, parent);
    endfunction : new

    virtual function void build_phase(uvm_phase phase);
        super.build_phase(phase);

        // 设置 10-bit 输入虚接口 (LLR)
        set_vif_10b("env.agent.drv", "vif", "s_axis_llr_vif");
        // 设置 1-bit 输出虚接口 (decoded)
        set_vif_1b("env.agent.mon", "vif", "m_axis_data_vif");

        // 设置 golden 路径
        uvm_config_db #(string)::set(this, "env.sb", "vec_dir", vec_dir);

        env = ldpc_env::type_id::create("env", this);
    endfunction : build_phase

    // ---- 设置 10-bit 虚接口 ----
    function void set_vif_10b(string comp_path, string field, string cfg_key);
        virtual axi_stream_if #(10) vif;
        if (!uvm_config_db #(virtual axi_stream_if #(10))::get(this, "", cfg_key, vif))
            `uvm_fatal("NOVIF", $sformatf("%s (#10) not set in config_db", cfg_key))
        uvm_config_db #(virtual axi_stream_if #(10))::set(this, comp_path, field, vif);
    endfunction

    // ---- 设置 1-bit 虚接口 ----
    function void set_vif_1b(string comp_path, string field, string cfg_key);
        virtual axi_stream_if #(1) vif;
        if (!uvm_config_db #(virtual axi_stream_if #(1))::get(this, "", cfg_key, vif))
            `uvm_fatal("NOVIF", $sformatf("%s (#1) not set in config_db", cfg_key))
        uvm_config_db #(virtual axi_stream_if #(1))::set(this, comp_path, field, vif);
    endfunction

    // ---- 复位序列 ----
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

    function void end_of_elaboration_phase(uvm_phase phase);
        uvm_top.print_topology();
    endfunction

    function void report_phase(uvm_phase phase);
        uvm_report_server svr = uvm_report_server::get_server();
        if (svr.get_severity_count(UVM_FATAL) +
            svr.get_severity_count(UVM_ERROR) == 0)
            `uvm_info(get_type_name(), "*** TEST PASSED ***", UVM_LOW)
        else
            `uvm_info(get_type_name(), "*** TEST FAILED ***", UVM_LOW)
    endfunction

endclass : ldpc_base_test
